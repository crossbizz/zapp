import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { WorkspaceAgentExecResult } from '../../src/provider/modal.js';
import {
  createGitTokenClient,
  createWorkspaceGitService,
  GitTokenGrantSchema,
  type GitTokenGrant,
  type GitTokenClient,
  type WorkspaceGitCommandPort,
} from '../../src/provider/git-bootstrap.js';
import type { WorkspaceAgentProvider, WorkspaceLifecycleRow, WorkspaceRowBoundary } from '../../src/routes/workspaces.js';
import { createScopedSecretInjector } from '../../src/secrets/injector.js';

const execFileAsync = promisify(execFile);

const IDS = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  branchId: 'br_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
  taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
  providerWorkspaceId: 'sb-workspace-1',
} as const;
const BRANCH_NAME = 'feature/checkout';
const OPERATION_KEY = `op_${'a'.repeat(64)}`;
const CLEAN_CLONE_URL =
  'https://forgejo.test/org_01j8me7yqzj2v9q0x3t5b6k7na/proj_01j8me7yqzj2v9q0x3t5b6k7nb.git';
const realGitEnvironment = {
  serviceUrl: process.env.GIT_SERVICE_URL ?? '',
  serviceSecret: process.env.SERVICE_TOKEN_SECRET ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
};
const hasRealGitEnvironment =
  /^https?:\/\//u.test(realGitEnvironment.serviceUrl) &&
  realGitEnvironment.serviceSecret.length >= 32 &&
  !realGitEnvironment.serviceSecret.includes('replace-me') &&
  /^postgres(?:ql)?:\/\//u.test(realGitEnvironment.databaseUrl);

async function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function authenticatedUrl(grant: GitTokenGrant): string {
  const url = new URL(grant.cloneUrl);
  url.username = 'x-access-token';
  url.password = grant.token;
  return url.toString();
}

async function databaseSql(sql: string): Promise<void> {
  const database = new URL(realGitEnvironment.databaseUrl);
  await execFileAsync('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: {
      ...process.env,
      PGHOST: database.hostname,
      PGPORT: database.port || '5432',
      PGUSER: decodeURIComponent(database.username),
      PGPASSWORD: decodeURIComponent(database.password),
      PGDATABASE: database.pathname.replace(/^\//u, ''),
    },
  });
}

async function createRepositoryFixture(root: string) {
  const bare = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const workspace = join(root, 'workspace');
  await execFileAsync('mkdir', ['-p', seed, workspace]);
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', bare]);
  await git(seed, 'init', '--initial-branch=main');
  await git(seed, 'config', 'user.name', 'seed');
  await git(seed, 'config', 'user.email', 'seed@zapp.test');
  await writeFile(join(seed, 'README.md'), 'seed\n');
  await git(seed, 'add', 'README.md');
  await git(seed, 'commit', '-m', 'seed');
  await git(seed, 'remote', 'add', 'origin', `file://${bare}`);
  await git(seed, 'push', 'origin', 'main');
  await git(seed, 'checkout', '-b', BRANCH_NAME);
  await writeFile(join(seed, 'branch.txt'), `${BRANCH_NAME}\n`);
  await git(seed, 'add', 'branch.txt');
  await git(seed, 'commit', '-m', 'requested branch');
  await git(seed, 'push', 'origin', BRANCH_NAME);
  return { bare, workspace };
}

describe('WS-5 scoped-token Git bootstrap', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('clones the explicit branch and remints an expired push without persisting credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-ws5-'));
    roots.push(root);
    const { bare, workspace } = await createRepositoryFixture(root);
    const grants = [
      { token: 'clone-token-sentinel', active: true, username: 'zt-clone' },
      { token: 'expired-token-sentinel', active: false, username: 'zt-expired' },
      { token: 'fresh-token-sentinel', active: true, username: 'zt-fresh' },
    ] as const;
    const requests: unknown[] = [];
    let nextGrant = 0;
    const tokens: GitTokenClient = {
      mint(input) {
        requests.push(input);
        const grant = grants[nextGrant++];
        if (grant === undefined) throw new Error('token fixture exhausted');
        return Promise.resolve({
          token: grant.token,
          username: grant.username,
          cloneUrl: CLEAN_CLONE_URL,
          expiresAt: '2026-08-09T00:05:00.000Z',
        });
      },
    };
    const commands: WorkspaceGitCommandPort = {
      async exec(input) {
        expect(input.providerWorkspaceId).toBe(IDS.providerWorkspaceId);
        expect(input.command).toBe('git');
        const args = input.args.map((argument) => {
          if (argument.startsWith('url.https://')) {
            const separator = argument.indexOf('.insteadOf=');
            const credentialUrl = argument.slice('url.'.length, separator);
            const cleanUrl = argument.slice(separator + '.insteadOf='.length);
            const url = new URL(credentialUrl);
            expect(cleanUrl).toBe(CLEAN_CLONE_URL);
            expect(url.username).toBe('x-access-token');
            const token = decodeURIComponent(url.password);
            const grant = grants.find((candidate) => candidate.token === token);
            expect(grant?.active).toBe(true);
            return `url.file://${bare}.insteadOf=${cleanUrl}`;
          }
          if (!argument.startsWith('https://')) return argument;
          const url = new URL(argument);
          expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(CLEAN_CLONE_URL);
          if (url.username === '') return argument;
          expect(url.username).toBe('x-access-token');
          const token = decodeURIComponent(url.password);
          const grant = grants.find((candidate) => candidate.token === token);
          if (grant?.active !== true) {
            return 'expired-token';
          }
          return `file://${bare}`;
        });
        if (args.includes('expired-token')) {
          return {
            exitCode: 128,
            stdout: '',
            stderr: 'authentication failed for expired-token-sentinel',
            durationMs: 1,
            truncated: false,
          };
        }
        try {
          const result = await git(workspace, ...args);
          return {
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: 1,
            truncated: false,
          };
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
            stderr: typeof failure.stderr === 'string' ? failure.stderr : 'git failed',
            durationMs: 1,
            truncated: false,
          };
        }
      },
    };
    const service = createWorkspaceGitService({ tokens, commands });
    const input = {
      ...IDS,
      branchName: BRANCH_NAME,
      operationKey: OPERATION_KEY,
    } as const;

    await service.bootstrap(input);

    expect((await git(workspace, 'branch', '--show-current')).stdout.trim()).toBe(BRANCH_NAME);
    expect((await git(workspace, 'remote', 'get-url', 'origin')).stdout.trim()).toBe(
      CLEAN_CLONE_URL,
    );
    expect((await git(workspace, 'config', '--get', 'credential.helper')).stdout).toBe('\n');
    expect((await git(workspace, 'config', '--get', 'user.name')).stdout.trim()).toBe(
      'zapp-agent',
    );
    expect((await git(workspace, 'config', '--get', 'user.email')).stdout.trim()).toBe(
      'agent@zapp.build',
    );
    const localConfig = await readFile(join(workspace, '.git', 'config'), 'utf8');
    for (const grant of grants) {
      expect(localConfig).not.toContain(grant.token);
    }
    expect(localConfig).not.toContain('x-access-token');

    await writeFile(join(workspace, 'round-trip.txt'), 'landed\n');
    await git(workspace, 'add', 'round-trip.txt');
    await git(workspace, 'commit', '-m', 'round trip');

    const expired = await service.push(input, []);
    expect(expired).toMatchObject({ exitCode: 128 });
    expect(expired.stderr).not.toContain('expired-token-sentinel');
    const pushed = await service.push(input, []);
    expect(pushed).toMatchObject({ exitCode: 0 });

    expect((await git(bare, 'show', `${BRANCH_NAME}:round-trip.txt`)).stdout).toBe('landed\n');
    expect(requests).toEqual([
      {
        organizationId: IDS.organizationId,
        projectId: IDS.projectId,
        access: 'read',
        ttlSec: 300,
        runId: IDS.runId,
        taskId: IDS.taskId,
      },
      {
        organizationId: IDS.organizationId,
        projectId: IDS.projectId,
        access: 'write',
        ttlSec: 300,
        runId: IDS.runId,
        taskId: IDS.taskId,
      },
      {
        organizationId: IDS.organizationId,
        projectId: IDS.projectId,
        access: 'write',
        ttlSec: 300,
        runId: IDS.runId,
        taskId: IDS.taskId,
      },
    ]);
  }, 15_000);

  it('makes workspace creation wait for clone and routes push through a fresh GIT-3 token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-ws5-route-'));
    roots.push(root);
    const { bare, workspace } = await createRepositoryFixture(root);
    const grants = [
      { token: 'route-clone-token', username: 'zt-route-clone' },
      { token: 'route-push-token', username: 'zt-route-push' },
    ] as const;
    let nextGrant = 0;
    const commands: WorkspaceGitCommandPort = {
      async exec(input) {
        const args = input.args.map((argument) => {
          if (argument.startsWith('url.https://')) {
            const separator = argument.indexOf('.insteadOf=');
            const credentialUrl = argument.slice('url.'.length, separator);
            const cleanUrl = argument.slice(separator + '.insteadOf='.length);
            const url = new URL(credentialUrl);
            expect(cleanUrl).toBe(CLEAN_CLONE_URL);
            expect(url.username).toBe('x-access-token');
            expect(grants.some(({ token }) => token === decodeURIComponent(url.password))).toBe(
              true,
            );
            return `url.file://${bare}.insteadOf=${cleanUrl}`;
          }
          if (!argument.startsWith('https://')) return argument;
          const url = new URL(argument);
          if (url.username === '') return argument;
          expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(CLEAN_CLONE_URL);
          expect(url.username).toBe('x-access-token');
          expect(grants.some(({ token }) => token === decodeURIComponent(url.password))).toBe(true);
          return `file://${bare}`;
        });
        const result = await git(workspace, ...args);
        return {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: 1,
          truncated: false,
        };
      },
    };
    let row: WorkspaceLifecycleRow = {
      id: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
      organizationId: IDS.organizationId,
      projectId: IDS.projectId,
      branchId: IDS.branchId,
      provider: 'modal',
      providerWorkspaceId: null,
      status: 'requested',
      resourceProfile: 'small',
      snapshotRef: null,
      createdAt: new Date('2026-08-08T12:00:00.000Z'),
      lastActiveAt: null,
      terminatedAt: null,
    };
    const rows: WorkspaceRowBoundary = {
      projectOwnedBy(projectId, organizationId) {
        return Promise.resolve(
          projectId === row.projectId && organizationId === row.organizationId,
        );
      },
      claimCreate() {
        return Promise.resolve({ created: true, row });
      },
      bindProviderWorkspaceId(_workspaceId, providerWorkspaceId) {
        row = { ...row, providerWorkspaceId };
        return Promise.resolve(row);
      },
      get(workspaceId, organizationId, projectId) {
        return Promise.resolve(
          workspaceId === row.id &&
            organizationId === row.organizationId &&
            projectId === row.projectId
            ? row
            : undefined,
        );
      },
      getAttachment() {
        return Promise.resolve(undefined);
      },
      transition(_workspaceId, status, patch) {
        row = { ...row, status, ...patch };
        return Promise.resolve(row);
      },
    };
    const unused = () => Promise.reject(new Error('unexpected provider operation'));
    const provider: WorkspaceAgentProvider = {
      lockedImageTag: 'forge-node-base:2026-08-08-c58a416',
      attachmentEnvironment: 'zapp-dev',
      imageTagForPurpose: () => 'forge-node-base:2026-08-08-c58a416',
      async createWorkspace(input, onAllocated) {
        await onAllocated?.(IDS.providerWorkspaceId);
        return {
          providerWorkspaceId: IDS.providerWorkspaceId,
          status: 'ready',
          resourceProfile: input.resourceProfile,
          imageTag: input.imageTag,
          createdAt: '2026-08-08T12:00:00.000Z',
          expiresAt: '2026-08-08T16:00:00.000Z',
        };
      },
      attachWorkspace: unused,
      terminateWorkspace: () => Promise.resolve(),
      getStatus: () => Promise.resolve('ready'),
      exec: async (input, idempotencyKey) =>
        (await commands.exec(
          input,
          idempotencyKey ?? OPERATION_KEY,
        )) as WorkspaceAgentExecResult,
      execStream: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      killExec: unused,
      readFile: unused,
      writeFile: unused,
      listFiles: unused,
      git: unused,
      health: unused,
      metrics: unused,
      readFileForUpdate: unused,
      writeFilesAtomically: unused,
      search: unused,
      deleteFile: unused,
      renameFile: unused,
      startDevServer: unused,
      restartDevServer: unused,
    };
    const app = buildApp({
      provider,
      rows,
      secrets: createScopedSecretInjector({
        decrypt: () => Promise.reject(new Error('Unexpected secret decrypt')),
      }),
      networkPolicies: { record: () => Promise.resolve() },
      gitService: {
        baseUrl: 'http://git-service.test:4500',
        serviceTokens: { secret: 's'.repeat(32) },
        fetch() {
          const grant = grants[nextGrant++];
          if (grant === undefined) throw new Error('token fixture exhausted');
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...grant,
                cloneUrl: CLEAN_CLONE_URL,
                expiresAt: '2026-08-09T00:05:00.000Z',
              }),
              { status: 201, headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      },
      serviceTokens: {
        verifyServiceToken: () =>
          Promise.resolve({
            ok: true as const,
            claims: { service: 'control-api', audience: 'sandbox-service' },
          }),
      },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    const create = await app.inject({
      method: 'POST',
      url: '/internal/workspaces',
      headers: {
        'x-zapp-service-token': 'service-token',
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': OPERATION_KEY,
      },
      payload: {
        workspace: row,
        branchName: BRANCH_NAME,
        runId: IDS.runId,
        taskId: IDS.taskId,
        purpose: 'builder',
        env: { PNPM_STORE_DIR: '/cache/pnpm' },
        networkProfile: 'dependency_install',
        operationKey: OPERATION_KEY,
      },
    });

    expect(create.statusCode, create.body).toBe(201);
    expect((await git(workspace, 'branch', '--show-current')).stdout.trim()).toBe(BRANCH_NAME);
    await writeFile(join(workspace, 'route-round-trip.txt'), 'route landed\n');
    await git(workspace, 'add', 'route-round-trip.txt');
    await git(workspace, 'commit', '-m', 'route round trip');

    const push = await app.inject({
      method: 'POST',
      url: `/internal/workspaces/${row.id}/git`,
      headers: {
        'x-zapp-service-token': 'service-token',
        'x-zapp-organization-id': IDS.organizationId,
        'x-zapp-project-id': IDS.projectId,
        'idempotency-key': `op_${'b'.repeat(64)}`,
      },
      payload: { operation: 'push' },
    });

    expect(push.statusCode, push.body).toBe(200);
    expect(push.json()).toMatchObject({ exitCode: 0 });
    expect((await git(bare, 'show', `${BRANCH_NAME}:route-round-trip.txt`)).stdout).toBe(
      'route landed\n',
    );
    await app.close();
  }, 15_000);

  it('mints a strict GIT-3 token with sandbox-service identity and no reusable response cache', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const client = createGitTokenClient({
      baseUrl: 'http://git-service.test:4500/path-that-must-not-be-used',
      serviceTokens: { secret: 's'.repeat(32) },
      fetch(input, init) {
        calls.push({ input, init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'git-token-sentinel',
              username: 'zt-123',
              cloneUrl: CLEAN_CLONE_URL,
              expiresAt: '2026-08-09T00:05:00.000Z',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });

    const grant = await client.mint({
      organizationId: IDS.organizationId,
      projectId: IDS.projectId,
      access: 'write',
      ttlSec: 300,
      runId: IDS.runId,
      taskId: IDS.taskId,
    });

    expect(grant).toMatchObject({ username: 'zt-123', cloneUrl: CLEAN_CLONE_URL });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://git-service.test:4500/internal/git/tokens');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.accept).toBe('application/json');
    expect(headers['cache-control']).toBe('no-store');
    const jwt = headers['x-zapp-service-token'];
    expect(jwt).toBeTypeOf('string');
    const claims = JSON.parse(
      Buffer.from(jwt?.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: 'sandbox-service', aud: 'git-service' });
    const requestBody = calls[0]?.init.body;
    expect(requestBody).toBeTypeOf('string');
    expect(JSON.parse(requestBody as string)).toEqual({
      organizationId: IDS.organizationId,
      projectId: IDS.projectId,
      access: 'write',
      ttlSec: 300,
      runId: IDS.runId,
      taskId: IDS.taskId,
    });
  });

  it.skipIf(!hasRealGitEnvironment)(
    'uses the real git-service and Forgejo for clone, revoked-token refusal, remint, and push [skipped without GIT_SERVICE_URL, SERVICE_TOKEN_SECRET, and DATABASE_URL]',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'zapp-ws5-real-'));
      roots.push(root);
      const seed = join(root, 'seed');
      const workspace = join(root, 'workspace');
      await execFileAsync('mkdir', ['-p', seed, workspace]);
      const organizationId = IDS.organizationId;
      const projectId = newId('proj');
      const branchId = newId('br');
      const runId = newId('run');
      const taskId = newId('task');
      const providerWorkspaceId = 'local-real-forgejo-workspace';
      await databaseSql(
        `insert into organizations (id, name, slug, plan, settings_json) values ('${organizationId}', 'WS-5 acceptance', 'ws-5-provider-acceptance', 'trial', '{}') on conflict (id) do nothing`,
      );
      const signer = createServiceTokenSigner({ secret: realGitEnvironment.serviceSecret });
      const signedRequest = async (method: 'POST' | 'DELETE', path: string, body?: unknown) => {
        const { token } = await signer.signServiceToken({
          service: 'sandbox-service',
          aud: 'git-service',
        });
        return fetch(new URL(path, realGitEnvironment.serviceUrl), {
          method,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-zapp-service-token': token,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      };
      let repositoryCreated = false;
      try {
        const created = await signedRequest('POST', '/internal/git/repositories', {
          organizationId,
          projectId,
          defaultBranch: 'main',
          protectReleaseBranches: false,
        });
        expect(created.status, await created.text()).toBe(201);
        repositoryCreated = true;
        const realTokens = createGitTokenClient({
          baseUrl: realGitEnvironment.serviceUrl,
          serviceTokens: { secret: realGitEnvironment.serviceSecret },
        });
        const seedGrant = GitTokenGrantSchema.parse(
          await realTokens.mint({
            organizationId,
            projectId,
            access: 'write',
            ttlSec: 300,
            runId,
            taskId,
          }),
        );
        await git(seed, 'init', '--initial-branch=main');
        await git(seed, 'config', 'user.name', 'seed');
        await git(seed, 'config', 'user.email', 'seed@zapp.test');
        await writeFile(join(seed, 'README.md'), 'seed\n');
        await git(seed, 'add', 'README.md');
        await git(seed, 'commit', '-m', 'seed');
        await git(seed, 'push', authenticatedUrl(seedGrant), 'HEAD:main');
        await git(seed, 'checkout', '-b', BRANCH_NAME);
        await writeFile(join(seed, 'branch.txt'), 'real provider branch\n');
        await git(seed, 'add', 'branch.txt');
        await git(seed, 'commit', '-m', 'branch');
        await git(seed, 'push', authenticatedUrl(seedGrant), `HEAD:${BRANCH_NAME}`);

        let queuedRevokedGrant: GitTokenGrant | undefined;
        const tokens: GitTokenClient = {
          async mint(input) {
            if (input.access === 'write' && queuedRevokedGrant !== undefined) {
              const grant = queuedRevokedGrant;
              queuedRevokedGrant = undefined;
              return grant;
            }
            return realTokens.mint(input);
          },
        };
        const commands: WorkspaceGitCommandPort = {
          async exec(input) {
            try {
              const result = await git(workspace, ...input.args);
              return {
                exitCode: 0,
                stdout: result.stdout,
                stderr: result.stderr,
                durationMs: 1,
                truncated: false,
              };
            } catch (error) {
              const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
              return {
                exitCode: typeof failure.code === 'number' ? failure.code : 1,
                stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
                stderr: typeof failure.stderr === 'string' ? failure.stderr : 'git failed',
                durationMs: 1,
                truncated: false,
              };
            }
          },
        };
        const service = createWorkspaceGitService({ tokens, commands });
        const input = {
          organizationId,
          projectId,
          branchId,
          branchName: BRANCH_NAME,
          providerWorkspaceId,
          runId,
          taskId,
          operationKey: OPERATION_KEY,
        } as const;
        await service.bootstrap(input);
        expect((await git(workspace, 'branch', '--show-current')).stdout.trim()).toBe(BRANCH_NAME);
        await writeFile(join(workspace, 'real-round-trip.txt'), 'real landed\n');
        await git(workspace, 'add', 'real-round-trip.txt');
        await git(workspace, 'commit', '-m', 'real round trip');

        queuedRevokedGrant = GitTokenGrantSchema.parse(
          await realTokens.mint({
            organizationId,
            projectId,
            access: 'write',
            ttlSec: 300,
            runId,
            taskId,
          }),
        );
        const revoked = await signedRequest('POST', '/internal/git/tokens/revoke', {
          organizationId,
          projectId,
        });
        expect(revoked.status, await revoked.text()).toBe(200);
        await expect(service.push(input, [])).resolves.toMatchObject({ exitCode: 128 });
        await expect(service.push(input, [])).resolves.toMatchObject({ exitCode: 0 });
        expect((await git(workspace, 'remote', 'get-url', 'origin')).stdout.trim()).toBe(
          seedGrant.cloneUrl,
        );
      } finally {
        if (repositoryCreated) {
          const deleted = await signedRequest(
            'DELETE',
            `/internal/git/repositories/${organizationId}/${projectId}`,
          );
          expect([204, 404]).toContain(deleted.status);
        }
      }
    },
    120_000,
  );
});
