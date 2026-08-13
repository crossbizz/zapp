import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { type ExecutionContract, newId } from '@zapp/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createModalNightlyE2eDriver,
  createModalSandboxProvider,
  type ModalImageLock,
  type WorkspaceAgentExecResult,
} from '../../src/provider/modal.js';
import { createFetchPreviewTransport } from '../../src/preview/transport.js';

const REPOSITORY_URL = 'https://github.com/crossbizz/zapp.git';
const TEMPLATE_PATH = 'source/apps/desktop/e2e-tests/fixtures/import-app/minimal';
const INSTALL_TIMEOUT_MS = 120_000;
const JOURNEY_TIMEOUT_MS = 10 * 60_000;
const CACHE_EXEC_ENV = {
  NPM_CONFIG_STORE_DIR: '/cache/pnpm',
  PNPM_STORE_DIR: '/cache/pnpm',
} as const;

const hasModalCredentials =
  typeof process.env.MODAL_TOKEN_ID === 'string' &&
  process.env.MODAL_TOKEN_ID !== '' &&
  typeof process.env.MODAL_TOKEN_SECRET === 'string' &&
  process.env.MODAL_TOKEN_SECRET !== '';

function bashLoginCommand(script: string): string[] {
  return ['-lc', script];
}

async function runOrThrow(
  provider: Pick<ReturnType<typeof createModalSandboxProvider>, 'exec'>,
  providerWorkspaceId: string,
  input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
): Promise<WorkspaceAgentExecResult> {
  const result = await provider.exec({
    providerWorkspaceId,
    command: input.command,
    args: [...input.args],
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${input.command} failed with exit ${String(result.exitCode)}: ${result.stderr.slice(0, 1_000)}`,
    );
  }
  return result;
}

async function installFixtureDependencies(
  provider: Pick<ReturnType<typeof createModalSandboxProvider>, 'exec'>,
  providerWorkspaceId: string,
  offline: boolean,
): Promise<WorkspaceAgentExecResult> {
  return runOrThrow(provider, providerWorkspaceId, {
    command: 'pnpm',
    args: [
      'install',
      '--ignore-workspace',
      '--frozen-lockfile',
      ...(offline ? ['--offline'] : []),
    ],
    cwd: TEMPLATE_PATH,
    env: CACHE_EXEC_ENV,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
}

async function expectPreviewHealthy(
  provider: ReturnType<typeof createModalSandboxProvider>,
  providerWorkspaceId: string,
): Promise<void> {
  const transport = createFetchPreviewTransport(provider);
  const response = await transport.request({
    providerWorkspaceId,
    method: 'GET',
    path: '/__zapp/healthz',
    publicOrigin: new URL('https://nightly.preview.zapp.test'),
    headers: { accept: 'application/json' },
  });
  const body: Buffer[] = [];
  for await (const chunk of response.body) body.push(Buffer.from(chunk));
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(Buffer.concat(body).toString('utf8'))).toEqual({ status: 'ok' });
  expect(JSON.stringify(response)).not.toContain('modal');
}

describe('WS-14 nightly Modal journey wiring', () => {
  it('executes containment shell scripts through Bash command mode', () => {
    expect(execFileSync('/bin/bash', bashLoginCommand('printf ops12-command-ran'), {
      encoding: 'utf8',
    })).toBe('ops12-command-ran');
  });

  it('is scheduled outside pull requests, pins the SDK, and pages Grafana OnCall on failure', async () => {
    const [workflow, packageJson] = await Promise.all([
      readFile(
        new URL('../../../../.github/workflows/modal-e2e.yml', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ]);
    const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.modal).toBe('0.9.0');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toContain('environment: modal-nightly');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain(
      'pnpm --filter @zapp/sandbox-service exec vitest run test/integration/modal-e2e.test.ts',
    );
    expect(workflow).toContain('secrets.MODAL_TOKEN_ID');
    expect(workflow).toContain('secrets.MODAL_TOKEN_SECRET');
    expect(workflow).toContain('test -n "$MODAL_TOKEN_ID"');
    expect(workflow).toContain('test -n "$MODAL_TOKEN_SECRET"');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('secrets.GRAFANA_ONCALL_INTEGRATION_URL');
  });

  it('forwards the supported pnpm cache configuration to the agent exec request', async () => {
    const exec = vi.fn().mockResolvedValue({
      durationMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: '/cache/pnpm/v3\n',
      truncated: false,
    } satisfies WorkspaceAgentExecResult);

    await runOrThrow({ exec }, 'sb_ws14', {
      command: 'pnpm',
      args: ['store', 'path'],
      env: CACHE_EXEC_ENV,
    });

    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        env: CACHE_EXEC_ENV,
      }),
    );
  });

  it('installs the sparse fixture as a standalone project', async () => {
    const exec = vi.fn().mockResolvedValue({
      durationMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: '',
      truncated: false,
    } satisfies WorkspaceAgentExecResult);

    await installFixtureDependencies({ exec }, 'sb_ws14', false);
    await installFixtureDependencies({ exec }, 'sb_ws14', true);

    expect(exec).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ['install', '--ignore-workspace', '--frozen-lockfile'],
        env: CACHE_EXEC_ENV,
      }),
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ['install', '--ignore-workspace', '--frozen-lockfile', '--offline'],
        env: CACHE_EXEC_ENV,
      }),
    );
  });
});

describe('OPS-12 real Modal abuse containment', () => {
  it.skipIf(!hasModalCredentials)(
    'blocks non-allowlisted egress and survives bounded process and memory exhaustion [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
    async () => {
      const lock = JSON.parse(
        await readFile(
          new URL('../../../../infra/modal/images.lock.json', import.meta.url),
          'utf8',
        ),
      ) as ModalImageLock;
      const locked = lock.environments.dev;
      if (locked === undefined) throw new Error('The dev Modal image lock is missing');

      const ids = {
        organizationId: newId('org'),
        projectId: newId('proj'),
        branchId: newId('br'),
        runId: newId('run'),
        taskId: newId('task'),
      } as const;
      const provider = createModalSandboxProvider({
        environment: 'dev',
        imageLock: lock,
        agentToken: `ops12-${crypto.randomUUID()}`,
      });
      let providerWorkspaceId: string | undefined;
      try {
        const handle = await provider.createWorkspace(
          {
            ...ids,
            purpose: 'builder',
            resourceProfile: 'small',
            imageTag: locked.images['forge-node-base'].publishedName,
            env: {},
            networkProfile: 'build_test',
          },
          async (allocatedId) => {
            providerWorkspaceId = allocatedId;
            await provider.updateNetworkPolicy({
              providerWorkspaceId: allocatedId,
              profile: 'build_test',
              allowedDomains: ['github.com'],
            });
          },
        );
        providerWorkspaceId = handle.providerWorkspaceId;

        const allowedEgress = await provider.exec({
          providerWorkspaceId,
          command: 'node',
          args: [
            '-e',
            "fetch('https://github.com', { redirect: 'manual', signal: AbortSignal.timeout(10000) }).then((response) => process.exit(response.status >= 200 && response.status < 500 ? 0 : 9), () => process.exit(9))",
          ],
          timeoutMs: 15_000,
        });
        expect(allowedEgress.exitCode).toBe(0);

        const blockedEgress = await provider.exec({
          providerWorkspaceId,
          command: 'node',
          args: [
            '-e',
            "fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(9), () => process.exit(0))",
          ],
          timeoutMs: 10_000,
        });
        expect(blockedEgress.exitCode).toBe(0);

        const processFanout = await provider.exec({
          providerWorkspaceId,
          command: '/bin/bash',
          args: bashLoginCommand(
            "rm -f /tmp/ops12-fork-escaped; setsid sh -c 'sleep 4; touch /tmp/ops12-fork-escaped' >/dev/null 2>&1 & for _ in $(seq 1 256); do (while :; do :; done) & done; wait",
          ),
          timeoutMs: 2_000,
        });
        expect(processFanout.exitCode).toBe(124);
        const noEscapedDescendant = await provider.exec({
          providerWorkspaceId,
          command: '/bin/bash',
          args: bashLoginCommand('sleep 5; test ! -e /tmp/ops12-fork-escaped'),
          timeoutMs: 10_000,
        });
        expect(noEscapedDescendant.exitCode).toBe(0);

        const memoryBalloon = await provider.exec({
          providerWorkspaceId,
          command: '/bin/bash',
          args: bashLoginCommand(
            "set -u; events=/sys/fs/cgroup/memory.events; before=$(awk '$1 == \"oom_kill\" { print $2 }' \"$events\"); node -e 'const held=[]; for (;;) { const chunk=Buffer.allocUnsafe(67108864); chunk.fill(90); held.push(chunk); }'; status=$?; after=$(awk '$1 == \"oom_kill\" { print $2 }' \"$events\"); test \"$status\" -ne 0; test \"$after\" -gt \"$before\"; printf 'oom_kill_delta=%s\\n' \"$((after-before))\"",
          ),
          timeoutMs: 60_000,
        });
        expect(memoryBalloon.exitCode).toBe(0);
        expect(memoryBalloon.stdout).toMatch(/oom_kill_delta=[1-9][0-9]*/u);
        await expect(provider.getStatus(providerWorkspaceId)).resolves.toBe('ready');
      } finally {
        if (providerWorkspaceId !== undefined) {
          await provider.terminateWorkspace(providerWorkspaceId).catch(() => undefined);
        }
      }
    },
    180_000,
  );
});

describe('WS-14 real Modal E2E', () => {
  it.skipIf(!hasModalCredentials)(
    'creates, caches, serves, snapshots, kills, restores, and terminates in zapp-dev [skipped without MODAL_TOKEN_ID and MODAL_TOKEN_SECRET]',
    async () => {
      const tokenId = process.env.MODAL_TOKEN_ID;
      const tokenSecret = process.env.MODAL_TOKEN_SECRET;
      if (tokenId === undefined || tokenId === '' || tokenSecret === undefined || tokenSecret === '') {
        throw new Error('Modal credentials disappeared after the test gate');
      }

      const lock = JSON.parse(
        await readFile(
          new URL('../../../../infra/modal/images.lock.json', import.meta.url),
          'utf8',
        ),
      ) as ModalImageLock;
      const locked = lock.environments.dev;
      if (locked === undefined) throw new Error('The dev Modal image lock is missing');
      expect(locked.sourceRevision).toMatch(/^[a-f0-9]{40}$/u);

      const ids = {
        organizationId: newId('org'),
        projectId: newId('proj'),
        branchId: newId('br'),
        runId: newId('run'),
        taskId: newId('task'),
      } as const;
      const agentToken = `ws14-${crypto.randomUUID()}`;
      const image = locked.images['forge-node-base'];
      const tags = {
        org_id: ids.organizationId,
        project_id: ids.projectId,
        branch_id: ids.branchId,
        run_id: ids.runId,
        task_id: ids.taskId,
        purpose: 'builder',
        environment: locked.modalEnvironment,
      } as const;
      const provider = createModalSandboxProvider({
        environment: 'dev',
        imageLock: lock,
        agentToken,
      });
      const nightly = createModalNightlyE2eDriver({
        environment: 'dev',
        imageLock: lock,
        agentToken,
        credentials: { tokenId, tokenSecret },
      });
      const contract: ExecutionContract = {
        version: 1,
        package_manager: 'pnpm',
        workspace_root: TEMPLATE_PATH,
        install: { command: 'true' },
        develop: { command: 'pnpm dev --host 127.0.0.1 --port 5173', port: 5173 },
        health: { path: '/' },
      };

      let firstWorkspaceId: string | undefined;
      let restoredWorkspaceId: string | undefined;
      let firstTerminated = false;
      try {
        const created = await provider.createWorkspace({
          ...ids,
          purpose: 'builder',
          resourceProfile: 'standard',
          imageTag: image.publishedName,
          env: {},
          networkProfile: 'dependency_install',
        });
        firstWorkspaceId = created.providerWorkspaceId;

        await runOrThrow(provider, firstWorkspaceId, {
          command: 'git',
          args: ['clone', '--filter=blob:none', '--no-checkout', REPOSITORY_URL, 'source'],
        });
        await runOrThrow(provider, firstWorkspaceId, {
          command: 'git',
          args: ['-C', 'source', 'sparse-checkout', 'set', 'apps/desktop/e2e-tests/fixtures/import-app/minimal'],
        });
        await runOrThrow(provider, firstWorkspaceId, {
          command: 'git',
          args: ['-C', 'source', 'fetch', '--depth=1', 'origin', locked.sourceRevision],
        });
        await runOrThrow(provider, firstWorkspaceId, {
          command: 'git',
          args: ['-C', 'source', 'checkout', '--detach', 'FETCH_HEAD'],
        });

        const storePath = await runOrThrow(provider, firstWorkspaceId, {
          command: 'pnpm',
          args: ['store', 'path'],
          cwd: TEMPLATE_PATH,
          env: CACHE_EXEC_ENV,
        });
        expect(storePath.stdout.trim()).toMatch(/^\/cache\/pnpm(?:\/|$)/u);

        const firstInstall = await installFixtureDependencies(provider, firstWorkspaceId, false);
        await runOrThrow(provider, firstWorkspaceId, {
          command: 'node',
          args: [
            '-e',
            "require('node:fs').rmSync('node_modules', { recursive: true, force: true })",
          ],
          cwd: TEMPLATE_PATH,
        });
        const cachedInstall = await installFixtureDependencies(provider, firstWorkspaceId, true);
        expect(cachedInstall.durationMs).toBeLessThanOrEqual(firstInstall.durationMs * 0.6);

        await provider.startDevServer(firstWorkspaceId, contract);
        await expectPreviewHealthy(provider, firstWorkspaceId);
        const checkpointMarker = Buffer.from(`checkpoint:${locked.tag}\n`);
        await provider.writeFile(
          firstWorkspaceId,
          `${TEMPLATE_PATH}/ws14-checkpoint.txt`,
          checkpointMarker,
        );

        const snapshotDigest = await nightly.checkpointAndKill(
          firstWorkspaceId,
          7 * 86_400_000,
        );
        firstTerminated = true;
        await expect(provider.getStatus(firstWorkspaceId)).resolves.toBe('terminated');

        restoredWorkspaceId = await nightly.restoreSnapshot({
          snapshotDigest,
          workspace: {
            ...ids,
            purpose: 'builder',
            resourceProfile: 'standard',
            imageTag: image.publishedName,
            env: {},
            networkProfile: 'dependency_install',
          },
        });

        const restartedProvider = createModalSandboxProvider({
          environment: 'dev',
          imageLock: lock,
          agentToken,
        });
        await restartedProvider.attachWorkspace(restoredWorkspaceId, {
          resourceProfile: 'standard',
          imageTag: image.publishedName,
          createdAt: new Date(),
          requiredTags: tags,
        });
        await expect(
          restartedProvider.readFile(restoredWorkspaceId, `${TEMPLATE_PATH}/ws14-checkpoint.txt`),
        ).resolves.toEqual(checkpointMarker);
        await restartedProvider.startDevServer(restoredWorkspaceId, contract);
        await expectPreviewHealthy(restartedProvider, restoredWorkspaceId);
        await restartedProvider.terminateWorkspace(restoredWorkspaceId);
        restoredWorkspaceId = undefined;
      } finally {
        if (restoredWorkspaceId !== undefined) {
          await provider.terminateWorkspace(restoredWorkspaceId).catch(() => undefined);
        }
        if (firstWorkspaceId !== undefined && !firstTerminated) {
          await provider.terminateWorkspace(firstWorkspaceId).catch(() => undefined);
        }
        nightly.close();
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});
