import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  createDockerWorkspaceSdk,
  createDockerSandboxProvider,
  dockerSnapshotId,
  providerSnapshotDigest,
  type DockerCommandPort,
} from '../src/provider/docker.js';
import type { ModalWorkspaceCreateOptions } from '../src/provider/modal.js';

const IMAGE =
  'ghcr.io/crossbizz/zapp-forge-node-base:ws17-e4372846317b407634038de5a48af8c307b9ceca@sha256:6009a9369bf92d6735c937b86d1f112b6110248442cdb2f3f953fdd721bc6d69';
const CONTAINER_ID = 'a'.repeat(64);
const SNAPSHOT_DIGEST = `sha256:${'b'.repeat(64)}`;

function createInput(): ModalWorkspaceCreateOptions {
  return {
    environment: 'zapp-dev',
    appName: 'zapp-workspaces',
    digest: 'im-test',
    publishedName: 'forge-node-base:2026-08-11-91b8ce9',
    tags: {
      org_id: 'org_test',
      project_id: 'proj_test',
      branch_id: 'br_test',
      run_id: 'run_test',
      task_id: 'task_test',
      purpose: 'build',
      environment: 'zapp-dev',
    },
    resources: {
      cpuRequest: 1,
      cpuLimit: 2,
      memRequestMiB: 1024,
      memLimitMiB: 2048,
    },
    environmentVariables: {
      ZAPP_AGENT_TOKEN: 'agent-token',
      ZAPP_WORKSPACE_ROOT: '/workspace/br_test',
    },
    sandboxName: `zapp-writer-${'c'.repeat(32)}`,
    volume: {
      name: 'vol-proj_proj_test',
      mounts: [{ mountPath: '/cache', subPath: '/cache' }],
    },
    command: ['/usr/bin/dumb-init', '--', '/opt/zapp/boot.sh'],
    encryptedPorts: [8877, 8080],
    readinessProbe: { kind: 'tcp', port: 8877, intervalMs: 250 },
    outboundCidrAllowlist: [],
    outboundDomainAllowlist: ['github.com'],
    timeoutMs: 30_000,
  };
}

function inspected(input = createInput(), connected = true): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      State: { Running: true },
      Config: {
        Labels: {
          ...Object.fromEntries(
            Object.entries(input.tags).map(([name, value]) => [`zapp.${name}`, value]),
          ),
          'zapp.sandbox_name': input.sandboxName,
        },
      },
      NetworkSettings: {
        Networks: connected ? { [`${input.sandboxName}-net`]: {} } : {},
        Ports: {
          '8877/tcp': [{ HostIp: '127.0.0.1', HostPort: '49151' }],
          '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }],
        },
      },
    },
  ]);
}

describe('local Docker workspace adapter', () => {
  it('reports connectivity-only network enforcement without claiming domain filtering', () => {
    const imageLock = JSON.parse(
      readFileSync(new URL('../../../infra/modal/images.lock.json', import.meta.url), 'utf8'),
    ) as unknown;
    const provider = createDockerSandboxProvider({
      environment: 'dev',
      imageLock,
      agentToken: 'agent-token',
    });

    expect(provider.networkPolicyEnforcement).toBe('connectivity_only');
  });

  it('creates one isolated branch container with loopback-only agent and preview ports', async () => {
    const calls: string[][] = [];
    const input = createInput();
    const command: DockerCommandPort = {
      async run(args) {
        await Promise.resolve();
        calls.push([...args]);
        if (args[0] === 'container' && args[1] === 'inspect' && args[2] === input.sandboxName) {
          return { exitCode: 1, stdout: '', stderr: 'not found' };
        }
        if (args[0] === 'run') return { exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: '' };
        if (args[0] === 'container' && args[1] === 'inspect') {
          return { exitCode: 0, stdout: inspected(input), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const sdk = createDockerWorkspaceSdk({ command, imageRef: IMAGE });

    const sandbox = await sdk.createWorkspace(input);
    const run = calls.find(
      ([operation, ...args]) => operation === 'run' && args.includes('--name'),
    );

    expect(sandbox.providerWorkspaceId).toBe(CONTAINER_ID);
    expect(calls).toContainEqual(['network', 'create', `${input.sandboxName}-net`]);
    expect(run).toEqual(
      expect.arrayContaining([
        '--name',
        input.sandboxName,
        '--network',
        `${input.sandboxName}-net`,
        '--cgroupns',
        'host',
        '--mount',
        `type=bind,source=/sys/fs/cgroup/${input.sandboxName}-cgroup,target=/sys/fs/cgroup`,
        '--publish',
        '127.0.0.1::8877',
        '--publish',
        '127.0.0.1::8080',
        '--volume',
        `${input.volume.name}:/workspace`,
        IMAGE,
      ]),
    );
    expect(run).not.toContain('--privileged');
    expect(run).toContain('NODE_OPTIONS=--dns-result-order=ipv4first');
    expect(
      calls.some(
        ([operation, ...args]) =>
          operation === 'run' && args.includes('--privileged') && args.includes('--network'),
      ),
    ).toBe(true);
    expect(await sandbox.getTags()).toEqual(input.tags);
    await expect(sandbox.tunnels(1_000)).resolves.toEqual({
      8080: { url: 'http://127.0.0.1:49152' },
      8877: { url: 'http://127.0.0.1:49151' },
    });
  });

  it('forwards authenticated agent requests and streaming bodies to the mapped host port', async () => {
    const input = createInput();
    const command: DockerCommandPort = {
      async run(args) {
        await Promise.resolve();
        if (args[0] === 'container' && args[1] === 'inspect') {
          return { exitCode: 0, stdout: inspected(input), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, details: 'ready', devServer: null }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('response-body', {
          status: 201,
          headers: { 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('first\nsecond\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      );
    const sdk = createDockerWorkspaceSdk({ command, imageRef: IMAGE, fetcher });
    const sandbox = await sdk.getWorkspace(CONTAINER_ID);
    expect(sandbox).toBeDefined();

    await expect(sandbox?.agentHealth('agent-token')).resolves.toMatchObject({ ok: true });
    const response = await sandbox?.agentRequest({
      method: 'POST',
      path: '/exec',
      headers: { authorization: 'Bearer agent-token' },
      body: Buffer.from('{}'),
    });
    expect(response).toMatchObject({ statusCode: 201, contentType: 'text/plain' });
    expect(Buffer.from(response?.body ?? []).toString()).toBe('response-body');

    const stream = await sandbox?.agentStream({
      method: 'POST',
      path: '/exec',
      query: { stream: '1' },
      headers: { authorization: 'Bearer agent-token' },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream?.body ?? []) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('first\nsecond\n');
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49151/exec',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('disconnects restricted workspaces, reconnects broader profiles, and cleans up idempotently', async () => {
    const input = createInput();
    let connected = true;
    let exists = true;
    const calls: string[][] = [];
    const command: DockerCommandPort = {
      async run(args) {
        await Promise.resolve();
        calls.push([...args]);
        if (args[0] === 'container' && args[1] === 'inspect') {
          if (!exists) return { exitCode: 1, stdout: '', stderr: 'not found' };
          return { exitCode: 0, stdout: inspected(input, connected), stderr: '' };
        }
        if (args[0] === 'network' && args[1] === 'disconnect') connected = false;
        if (args[0] === 'network' && args[1] === 'connect') connected = true;
        if (args[0] === 'rm') exists = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const sdk = createDockerWorkspaceSdk({ command, imageRef: IMAGE });
    const sandbox = await sdk.getWorkspace(CONTAINER_ID);

    await sandbox?.updateNetworkPolicy({
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: [],
    });
    await sandbox?.updateNetworkPolicy({
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: ['github.com'],
    });
    await sandbox?.terminate();
    await sandbox?.terminate();

    expect(calls).toContainEqual([
      'network',
      'disconnect',
      `${input.sandboxName}-net`,
      CONTAINER_ID,
    ]);
    expect(calls).toContainEqual([
      'network',
      'connect',
      `${input.sandboxName}-net`,
      CONTAINER_ID,
    ]);
    expect(calls).toContainEqual(['rm', '--force', CONTAINER_ID]);
    expect(calls).toContainEqual(['network', 'rm', `${input.sandboxName}-net`]);
  });

  it('maps Docker image digests to closed provider snapshot identifiers', () => {
    expect(dockerSnapshotId(SNAPSHOT_DIGEST)).toBe(`im-docker-${'b'.repeat(64)}`);
    expect(providerSnapshotDigest(`im-docker-${'b'.repeat(64)}`)).toBe(SNAPSHOT_DIGEST);
    expect(() => dockerSnapshotId('latest')).toThrow();
  });
});
