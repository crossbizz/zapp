import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import type { CreateWorkspaceInput, ExecutionContract } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import { createDockerSandboxProvider } from '../../src/provider/docker.js';

const LIVE = process.env.ZAPP_DOCKER_LIVE === '1';
const AGENT_TOKEN = 'local-docker-integration-agent-token';
const IDS = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7PA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7PB',
  branchId: 'br_01J8ME7YQZJ2V9Q0X3T5B6K7PC',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7PD',
  taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7PE',
} as const;

describe('live local Docker provider', () => {
  it.skipIf(!LIVE)(
    'boots the locked image, serves the agent and preview proxy, and terminates cleanly',
    async () => {
      const imageLock = JSON.parse(
        await readFile(new URL('../../../../infra/modal/images.lock.json', import.meta.url), 'utf8'),
      ) as unknown;
      const lockedTag = (
        imageLock as {
          environments: { dev: { images: { 'forge-node-base': { publishedName: string } } } };
        }
      ).environments.dev.images['forge-node-base'].publishedName;
      const provider = createDockerSandboxProvider({
        environment: 'dev',
        imageLock,
        agentToken: AGENT_TOKEN,
      });
      expect(provider.networkPolicyEnforcement).toBe('connectivity_only');
      const input: CreateWorkspaceInput = {
        ...IDS,
        purpose: 'builder',
        resourceProfile: 'small',
        imageTag: lockedTag,
        env: { PNPM_STORE_DIR: '/cache/pnpm' },
        networkProfile: 'dependency_install',
      };
      let providerWorkspaceId: string | undefined;
      try {
        const workspace = await provider.createWorkspace(input);
        providerWorkspaceId = workspace.providerWorkspaceId;

        await expect(provider.health(providerWorkspaceId)).resolves.toMatchObject({ ok: true });
        const node = await provider.exec({
          providerWorkspaceId,
          command: 'node',
          args: ['--version'],
          timeoutMs: 10_000,
        });
        expect(node).toMatchObject({ exitCode: 0, truncated: false });
        expect(node.stdout.trim()).toMatch(/^v22\./u);

        await provider.exec({
          providerWorkspaceId,
          command: 'sh',
          args: ['-lc', 'find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'],
          cwd: '.',
          timeoutMs: 10_000,
        });
        await provider.writeFile(
          providerWorkspaceId,
          'package.json',
          Buffer.from(
            JSON.stringify({
              name: 'dependency-install-preview-proof',
              private: true,
              scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
              devDependencies: { vite: '5.4.21' },
            }),
          ),
        );
        await provider.writeFile(
          providerWorkspaceId,
          'index.html',
          Buffer.from('<h1>Dependency install preview ready</h1>'),
        );
        const contract: ExecutionContract = {
          version: 1,
          package_manager: 'pnpm',
          workspace_root: '.',
          install: { command: 'pnpm install', timeout_seconds: 90 },
          develop: { command: 'pnpm dev', port: 5173 },
        };
        try {
          await expect(provider.startDevServer(providerWorkspaceId, contract)).resolves.toMatchObject({
            port: 5173,
            ownership: 'process_group',
          });
        } catch (error: unknown) {
          const logs = await provider.readDevServerLogs(providerWorkspaceId, {
            after: 0,
            limit: 100,
          });
          throw new Error(
            `Live preview startup failed: ${logs.entries.map((entry) => entry.message).join('')}`,
            { cause: error },
          );
        }
        await expect(
          provider.statFile(providerWorkspaceId, 'node_modules/.bin/vite'),
        ).resolves.toMatchObject({ path: 'node_modules/.bin/vite' });

        const preview = await provider.resolvePreviewTunnel(providerWorkspaceId);
        expect(preview.protocol).toBe('http:');
        expect(preview.hostname).toBe('127.0.0.1');
        const health = await fetch(new URL('/__zapp/healthz', preview));
        expect(health.status).toBe(200);
        const document = await fetch(preview);
        expect(document.status).toBe(200);
        await expect(document.text()).resolves.toContain('Dependency install preview ready');
      } finally {
        if (providerWorkspaceId !== undefined) {
          await provider.terminateWorkspace(providerWorkspaceId);
        }
      }
    },
    120_000,
  );
});
