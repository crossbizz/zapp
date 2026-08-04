import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { internalRepoRef } from '@zapp/contracts';
import {
  composeApp as composeGitService,
  loadForgejoEnv,
  type AppInstance as GitServiceApp,
} from '@zapp/git-service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp, type AppInstance as ControlApiApp } from '../../src/app.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { loadServiceTokenConfig } from '../../src/env.js';
import { createGitServiceClient } from '../../src/git/client.js';
import { createDbOrganizationStore, type OrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { credentialGate } from '../support/credentials.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, TEST_RATE_LIMITS, cookieJar, cookiesOf } from '../support/harness.js';
import { setUpTestDatabase, type TestDatabase } from '../integration/helpers.js';

/**
 * GATE-5: the deployed project-creation join, with no fake at either network edge.
 *
 * The request enters a listening control-api over HTTP. Its shipping Git HTTP
 * client calls a listening git-service with a real service token. The shipping
 * git-service composition binds the real Forgejo provider, and the final
 * assertion asks Forgejo for the repository and runs `git ls-remote` against
 * the clone URL Forgejo returned. A fake client or provider cannot satisfy it.
 */

const REQUIRED_CREDENTIALS = [
  'DATABASE_URL',
  'FORGEJO_URL',
  'FORGEJO_ADMIN_TOKEN',
  'SERVICE_TOKEN_SECRET',
] as const;
const gate = credentialGate(REQUIRED_CREDENTIALS);

function inContinuousIntegration(): boolean {
  const flag = (process.env['CI'] ?? '').trim().toLowerCase();
  return flag !== '' && flag !== 'false' && flag !== '0';
}

if (!gate.present && inContinuousIntegration()) {
  throw new Error(
    `refusing to skip GATE-5: CI is set but ${gate.reason}. The control-api -> git-service -> Forgejo join would be unverified.`,
  );
}

if (!gate.present) {
  console.warn(
    `[@zapp/control-api] GATE-5 SKIPPED — not run, not passed: ${gate.reason} — start the dev stack with ./scripts/dev-up.sh`,
  );
}

const ProjectResponseSchema = z
  .object({
    project: z.object({ id: z.string() }),
    repository: z.object({ internalRepoRef: z.string(), defaultBranch: z.string() }),
  })
  .passthrough();

const ForgejoRepositorySchema = z
  .object({
    clone_url: z.string().url(),
    private: z.boolean(),
    empty: z.boolean(),
    default_branch: z.string(),
  })
  .passthrough();

interface Member {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

const run = promisify(execFile);

describe.skipIf(!gate.present)('GATE-5 control-api -> git-service -> Forgejo', () => {
  let database: TestDatabase | undefined;
  let organizations: OrganizationStore;
  let auth: FakeAuthPort;
  let gitService: GitServiceApp | undefined;
  let controlApi: ControlApiApp | undefined;
  let controlApiUrl: string;
  let organizationId: string | undefined;

  function testDatabase(): TestDatabase {
    if (database === undefined) {
      throw new Error('GATE-5 database is not ready');
    }
    return database;
  }

  async function signIn(email: string): Promise<Member> {
    const login = await fetch(`${controlApiUrl}/v1/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const code = `gate5-${email}`;
    auth.issueCode(code, { externalId: `external-${email}`, email, displayName: email });

    const callback = await fetch(
      `${controlApiUrl}/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      {
        redirect: 'manual',
        headers: { cookie: cookieJar(cookiesOf(login.headers.getSetCookie())) },
      },
    );
    expect(callback.status).toBe(302);
    const cookies = cookiesOf(callback.headers.getSetCookie());
    const [user] = await testDatabase().sql<{ id: string }[]>`
      select id from users where email = ${email}
    `;
    if (user === undefined) {
      throw new Error('GATE-5 sign-in created no user');
    }
    return {
      userId: user.id,
      headers: {
        cookie: cookieJar(cookies),
        [CSRF_HEADER]: cookies.get(CSRF_COOKIE) ?? '',
      },
    };
  }

  async function forgejoRequest(path: string, method: 'GET' | 'DELETE'): Promise<Response> {
    const baseUrl = loadForgejoEnv(process.env).baseUrl;
    return await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `token ${process.env['FORGEJO_ADMIN_TOKEN'] ?? ''}`,
      },
    });
  }

  async function removeForgejoOrganization(): Promise<void> {
    if (organizationId === undefined) return;
    const owner = organizationId.toLowerCase();
    const listed = await forgejoRequest(`/orgs/${encodeURIComponent(owner)}/repos?limit=50`, 'GET');
    if (listed.status === 200) {
      const repositories = z
        .array(z.object({ name: z.string() }).passthrough())
        .parse(await listed.json());
      for (const repository of repositories) {
        const removed = await forgejoRequest(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository.name)}`,
          'DELETE',
        );
        if (removed.status !== 204 && removed.status !== 404) {
          throw new Error(`GATE-5 cleanup could not remove its repository (${String(removed.status)})`);
        }
      }
    } else if (listed.status !== 404) {
      throw new Error(`GATE-5 cleanup could not list its repositories (${String(listed.status)})`);
    }

    const removed = await forgejoRequest(`/orgs/${encodeURIComponent(owner)}`, 'DELETE');
    if (removed.status !== 204 && removed.status !== 404) {
      throw new Error(`GATE-5 cleanup could not remove its organization (${String(removed.status)})`);
    }
  }

  async function proveClonePath(cloneUrl: string): Promise<void> {
    const parsed = new URL(cloneUrl);
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');

    const directory = await mkdtemp(join(tmpdir(), 'zapp-gate5-'));
    const askPass = join(directory, 'askpass.sh');
    await writeFile(
      askPass,
      `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'zapp-admin-token' ;;\n  *) printf '%s\\n' "$FORGEJO_ADMIN_TOKEN" ;;\nesac\n`,
      { mode: 0o700 },
    );
    await chmod(askPass, 0o700);
    try {
      await run('git', ['ls-remote', cloneUrl], {
        cwd: directory,
        env: {
          ...process.env,
          GIT_ASKPASS: askPass,
          GIT_ASKPASS_REQUIRE: 'force',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : 'unknown';
      throw new Error(`GATE-5 git ls-remote failed (${code})`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  beforeAll(async () => {
    const readyDatabase = await setUpTestDatabase();
    database = readyDatabase;
    await readyDatabase.truncateIdentity();
    const serviceTokens = loadServiceTokenConfig(process.env);

    const gitComposition = composeGitService({
      forgejo: loadForgejoEnv(process.env),
      serviceTokens,
      database: readyDatabase.db,
      logger: false,
    });
    const readyGitService = gitComposition.app;
    gitService = readyGitService;
    const gitServiceUrl = await readyGitService.listen({ host: '127.0.0.1', port: 0 });

    organizations = createDbOrganizationStore(readyDatabase.db);
    auth = new FakeAuthPort();
    const readyControlApi = buildApp({
      logger: false,
      auth: { port: auth, users: createDbUserStore(readyDatabase.db), config: TEST_AUTH_CONFIG },
      orgs: { organizations, audit: createDbAuditSink(readyDatabase.db) },
      tenant: {
        tenantDb: createTenantDbFactory(readyDatabase.db),
        git: createGitServiceClient({ baseUrl: gitServiceUrl, serviceTokens }),
      },
      limits: { config: TEST_RATE_LIMITS },
    });
    controlApi = readyControlApi;
    controlApiUrl = await readyControlApi.listen({ host: '127.0.0.1', port: 0 });
  }, 180_000);

  afterAll(async () => {
    await removeForgejoOrganization();
    if (controlApi !== undefined) await controlApi.close();
    if (gitService !== undefined) await gitService.close();
    if (database !== undefined) await database.close();
  });

  it('creates a project over HTTP and leaves a private, cloneable Forgejo repository', async () => {
    const owner = await signIn('owner@gate5.test');
    organizationId = (
      await organizations.create({
        name: 'gate5',
        slug: `gate5-${owner.userId.slice(-6).toLowerCase()}`,
        creatorUserId: owner.userId,
        now: new Date(),
        link: () => Promise.resolve({ externalOrgId: `external-${owner.userId}` }),
        audit: () => Promise.resolve(),
      })
    ).organization.id;

    const response = await fetch(`${controlApiUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: organizationId,
        'content-type': 'application/json',
        'idempotency-key': 'gate5-project-create',
      },
      body: JSON.stringify({ name: 'GATE-5 live repository' }),
    });
    const responseBody: unknown = await response.json();
    expect(response.status).toBe(201);
    const created = ProjectResponseSchema.parse(responseBody);
    const expectedRef = internalRepoRef({
      organizationId,
      projectId: created.project.id,
    });
    expect(created.repository).toMatchObject({
      internalRepoRef: expectedRef,
      defaultBranch: 'main',
    });

    const [repositoryRow] = await testDatabase().sql<{ provisioned_at: string | null }[]>`
      select provisioned_at from repositories where project_id = ${created.project.id}
    `;
    expect(repositoryRow?.provisioned_at).not.toBeNull();

    const [ownerName, repositoryName] = expectedRef.split('/') as [string, string];
    const forgejo = await forgejoRequest(
      `/repos/${encodeURIComponent(ownerName)}/${encodeURIComponent(repositoryName)}`,
      'GET',
    );
    expect(forgejo.status).toBe(200);
    const details = ForgejoRepositorySchema.parse(await forgejo.json());
    expect(details).toMatchObject({ private: true, empty: true, default_branch: 'main' });
    await proveClonePath(details.clone_url);
  }, 180_000);
});
