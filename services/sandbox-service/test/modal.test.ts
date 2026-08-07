import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createModalImagePublisher,
  imageDockerfileCommands,
  type ModalSdkPort,
  type ModalSdkSandboxPort,
} from '../src/provider/modal.js';
import { ImageRecipeSchema, SmokeImageInputSchema } from '../src/provider/types.js';

const TAG = '2026-08-05-abcdef0';

function baseRecipe() {
  return ImageRecipeSchema.parse({
    imageName: 'forge-node-base',
    base: {
      kind: 'registry',
      ref: 'node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
    },
    commands: ['RUN node --version'],
    files: [],
  });
}

interface StatefulSandboxOptions {
  readonly cleanupFailure?: boolean;
}

function successfulSandbox(
  commands: string[][],
  terminate: () => void,
  options: StatefulSandboxOptions = {},
): ModalSdkSandboxPort {
  const cleanupIds = new Set<string>();
  return {
    exec(command) {
      commands.push(command);
      for (const match of command.join('\n').matchAll(/cleanupId=([a-f0-9-]{36})/gu)) {
        const cleanupId = match[1];
        if (cleanupId !== undefined) cleanupIds.add(cleanupId);
      }
      if (command[0] === 'node') {
        return Promise.resolve({ exitCode: 0, stdout: 'v22.23.1\n', stderr: '' });
      }
      const url = command.at(-1) ?? '';
      if (command[0] === 'curl' && url.endsWith('/healthz')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, details: 'workspace-agent ready' }),
          stderr: '',
        });
      }
      if (command[0] === 'curl' && url.includes('/exec/cleanup/')) {
        const cleanupId = url.split('/').at(-1) ?? '';
        if (options.cleanupFailure === true || !cleanupIds.has(cleanupId)) {
          return Promise.resolve({
            exitCode: 22,
            stdout: JSON.stringify({ error: 'containment_cleanup_failed' }),
            stderr: '',
          });
        }
        cleanupIds.delete(cleanupId);
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ cleaned: true }),
          stderr: '',
        });
      }
      if (command[0] === 'curl') {
        const body = command[command.indexOf('--data') + 1] ?? '';
        const cleanupId = new URL(url).searchParams.get('cleanupId');
        if (cleanupId !== null) cleanupIds.add(cleanupId);
        return Promise.resolve({
          exitCode: 0,
          stdout: body.includes('setsid')
            ? JSON.stringify({
                exitCode: -1,
                stdout: '',
                stderr: '',
                durationMs: 250,
                truncated: false,
              })
            : JSON.stringify({
                exitCode: 0,
                stdout: '',
                stderr: '',
                durationMs: 5,
                truncated: false,
              }),
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
    waitUntilReady() {
      return Promise.resolve();
    },
    tunnels() {
      return Promise.resolve({ 8877: { url: 'https://agent-tunnel.modal.run' } });
    },
    snapshotFilesystem() {
      return Promise.resolve('im-snapshot0123');
    },
    terminate() {
      terminate();
      return Promise.resolve();
    },
  };
}

describe('Modal image provider facade', () => {
  test('rejects telemetry endpoints that can carry credentials into a sandbox', () => {
    const base = {
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
    } as const;
    const credentialEndpoint = new URL(
      '/v1/telemetry',
      'https://sandbox-service.internal',
    );
    credentialEndpoint.username = 'fixture-user';
    credentialEndpoint.password = 'fixture-password';
    for (const telemetryEndpoint of [
      'http://sandbox-service.internal/v1/telemetry',
      credentialEndpoint.toString(),
      'https://sandbox-service.internal/v1/telemetry?token=secret',
      'https://sandbox-service.internal/v1/telemetry#api-key',
    ]) {
      expect(() => SmokeImageInputSchema.parse({ ...base, telemetryEndpoint })).toThrow();
    }
    expect(() =>
      SmokeImageInputSchema.parse({
        ...base,
        telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
      }),
    ).not.toThrow();
  });

  test('materializes baked files before commands that consume them', () => {
    const commands = imageDockerfileCommands(
      ImageRecipeSchema.parse({
        imageName: 'forge-node-base',
        base: baseRecipe().base,
        commands: ['RUN npm ci --prefix /opt/zapp/browser'],
        files: [
          {
            path: '/opt/zapp/browser/package-lock.json',
            mode: '0644',
            contents: '{"lockfileVersion":3}\n',
          },
        ],
      }),
    );

    expect(commands.findIndex((command) => command.includes('package-lock.json'))).toBeLessThan(
      commands.indexOf('RUN npm ci --prefix /opt/zapp/browser'),
    );
  });

  test('maps project-owned publication input to an immutable SDK build result', async () => {
    const builds: unknown[] = [];
    const publications: unknown[] = [];
    let resolveCalls = 0;
    let closed = false;
    const sdk: ModalSdkPort = {
      buildImage(input) {
        builds.push(input);
        return Promise.resolve('im-built0123');
      },
      resolvePublishedImage() {
        resolveCalls += 1;
        return Promise.resolve(resolveCalls === 1 ? undefined : 'im-built0123');
      },
      publishImageId(input) {
        publications.push(input);
        return Promise.resolve();
      },
      createVmSandbox() {
        return Promise.reject(new Error('not used'));
      },
      close() {
        closed = true;
      },
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    const result = await publisher.publishImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      imageName: 'forge-node-base',
      tag: TAG,
      publishedName: `forge-node-base:${TAG}`,
      recipe: baseRecipe(),
    });

    expect(builds).toEqual([
      expect.objectContaining({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        publishedName: `forge-node-base:${TAG}`,
        recipe: baseRecipe(),
      }),
    ]);
    expect(result).toEqual({
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
    });
    expect(publications).toEqual([
      {
        environment: 'zapp-dev',
        publishedName: `forge-node-base:${TAG}`,
        digest: 'im-built0123',
      },
    ]);
    expect(closed).toBe(true);
  });

  test('treats an existing immutable name as idempotent only for the exact built image ID', async () => {
    let publicationCount = 0;
    const sdk = {
      buildImage: () => Promise.resolve('im-built0123'),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => {
        publicationCount += 1;
        return Promise.resolve();
      },
      createVmSandbox: () => Promise.reject(new Error('not used')),
      close() {},
    } satisfies ModalSdkPort;
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await expect(
      publisher.publishImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        imageName: 'forge-node-base',
        tag: TAG,
        publishedName: `forge-node-base:${TAG}`,
        recipe: baseRecipe(),
      }),
    ).resolves.toEqual({
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
    });
    expect(publicationCount).toBe(0);
  });

  test('rejects immutable-name mismatches before publication and races after publication', async () => {
    for (const resolutions of [['im-other0123'], [undefined, 'im-raced0123']] as const) {
      let publicationCount = 0;
      let resolveIndex = 0;
      const sdk = {
        buildImage: () => Promise.resolve('im-built0123'),
        resolvePublishedImage: () => Promise.resolve(resolutions[resolveIndex++]),
        publishImageId: () => {
          publicationCount += 1;
          return Promise.resolve();
        },
        createVmSandbox: () => Promise.reject(new Error('not used')),
        close() {},
      } satisfies ModalSdkPort;
      const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

      await expect(
        publisher.publishImage({
          environment: 'zapp-dev',
          appName: 'zapp-workspaces',
          imageName: 'forge-node-base',
          tag: TAG,
          publishedName: `forge-node-base:${TAG}`,
          recipe: baseRecipe(),
        }),
      ).rejects.toThrow('Immutable image name resolves to a different image ID');
      expect(publicationCount).toBe(resolutions[0] === undefined ? 1 : 0);
    }
  });

  test('fails closed when the provider boundary resolves a published name to another digest', async () => {
    let closed = false;
    const sdk = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-raced0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.reject(new Error('not used')),
      close() {
        closed = true;
      },
    } satisfies ModalSdkPort;
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await expect(
      publisher.verifyPublishedImage({
        environment: 'zapp-dev',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
      }),
    ).rejects.toThrow('Published image name no longer resolves to the expected digest');
    expect(closed).toBe(true);
  });

  test('requests the V2 VM runtime, proves agent containment, and terminates the sandbox', async () => {
    const commands: string[][] = [];
    const createRequests: unknown[] = [];
    let terminationCount = 0;
    const sdk: ModalSdkPort = {
      buildImage() {
        return Promise.reject(new Error('not used'));
      },
      resolvePublishedImage() {
        return Promise.resolve('im-built0123');
      },
      publishImageId() {
        return Promise.reject(new Error('not used'));
      },
      createVmSandbox(input) {
        createRequests.push(input);
        return Promise.resolve(
          successfulSandbox(commands, () => {
            terminationCount += 1;
          }),
        );
      },
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    const result = await publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
      telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
    });

    expect(createRequests).toEqual([
      expect.objectContaining({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        experimentalOptions: { vm_runtime: true },
      }),
    ]);
    expect(createRequests).toEqual([
      expect.objectContaining({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        experimentalOptions: { vm_runtime: true },
        encryptedPorts: [8877],
        readinessProbe: { kind: 'tcp', port: 8877, intervalMs: 250 },
        volumeMountPath: '/workspace-probe',
      }),
    ]);
    const serializedCommands = commands.flat().join('\n');
    for (const requiredProbe of [
      'buffered-timeout',
      'pty-timeout',
      'disconnect-buffered',
      'disconnect-pty',
      'explicit-kill-buffered',
      'explicit-kill-pty',
      'agent-shutdown-buffered',
      'agent-shutdown-pty',
      'pid-ownership',
      '/workspace-probe',
      '/exec/cleanup/',
    ]) {
      expect(serializedCommands).toContain(requiredProbe);
    }
    const explicitKillScripts = commands
      .filter((command) => command[0] === 'sh' && command.join('\n').includes('explicit-kill-'))
      .map((command) => command.join('\n'));
    expect(explicitKillScripts).toHaveLength(4);
    const explicitKillRequests = explicitKillScripts.filter((value) =>
      value.includes('Idempotency-Key'),
    );
    expect(explicitKillRequests).toHaveLength(2);
    for (const script of explicitKillRequests) {
      const keys = [...script.matchAll(/Idempotency-Key: ([a-f0-9-]{36})/gu)].map(
        (match) => match[1],
      );
      expect(new Set(keys).size).toBe(2);
    }
    const shutdownScripts = commands
      .filter((command) => command[0] === 'sh' && command.join('\n').includes('agent-shutdown-'))
      .map((command) => command.join('\n'));
    expect(shutdownScripts).toHaveLength(2);
    for (const script of shutdownScripts) {
      const startedAssertion = script.indexOf('test -n "$pid"');
      const activeAssertion = script.indexOf('kill -0 "$request_pid"');
      const shutdownSignal = script.indexOf('kill -TERM "$agent_pid"');
      expect(startedAssertion).toBeGreaterThan(-1);
      expect(script.match(/jq -er/gu)?.length).toBeGreaterThanOrEqual(2);
      expect(activeAssertion).toBeGreaterThan(startedAssertion);
      expect(shutdownSignal).toBeGreaterThan(activeAssertion);
    }
    const ownershipScript = commands
      .find((command) => command[0] === 'sh' && command.join('\n').includes('pid-ownership'))
      ?.join('\n');
    expect(ownershipScript).toContain('generation_a');
    expect(ownershipScript).toContain('generation_b');
    expect(ownershipScript).toContain('pid_b');
    expect(ownershipScript?.match(/executionId/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({
      nodeVersion: 'v22.23.1',
      health: { ok: true, details: 'workspace-agent ready' },
      vmRuntime: true,
      cgroup: { delegated: true, kill: true, emptySignal: true },
      lifecycle: {
        timeout: { buffered: true, pty: true },
        disconnect: { buffered: true, pty: true },
        explicitKill: { buffered: true, pty: true },
        agentShutdown: { buffered: true, pty: true },
        pidOwnership: true,
      },
      capabilities: {
        volumeReadWrite: true,
        filesystemSnapshot: 'im-snapshot0123',
        encryptedTunnel: true,
        readinessProbe: true,
      },
      terminated: true,
    });
    expect(terminationCount).toBe(1);
  });

  test('rejects a smoke when the immutable name does not resolve to the lock digest', async () => {
    let createCount = 0;
    const sdk = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-other0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => {
        createCount += 1;
        return Promise.reject(new Error('must not create'));
      },
      close() {},
    } satisfies ModalSdkPort;
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await expect(
      publisher.smokeImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
        agentToken: randomUUID(),
      }),
    ).rejects.toThrow('Locked image digest does not match the published name');
    expect(createCount).toBe(0);
  });

  test('fails closed when an exact execution cleanup acknowledgement reports failure', async () => {
    const sdk: ModalSdkPort = {
      buildImage() {
        return Promise.reject(new Error('not used'));
      },
      resolvePublishedImage() {
        return Promise.resolve('im-built0123');
      },
      publishImageId() {
        return Promise.reject(new Error('not used'));
      },
      createVmSandbox() {
        return Promise.resolve(successfulSandbox([], () => undefined, { cleanupFailure: true }));
      },
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await expect(
      publisher.smokeImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
        agentToken: randomUUID(),
        telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
      }),
    ).rejects.toThrow('containment cleanup acknowledgement failed');
  });

  test('retries the authenticated health probe while the baked agent is starting', async () => {
    let healthAttempts = 0;
    const sandbox = successfulSandbox([], () => undefined);
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command) => {
      if (command[0] === 'curl' && command.at(-1)?.endsWith('/healthz')) {
        healthAttempts += 1;
        if (healthAttempts === 1) {
          return Promise.resolve({ exitCode: 7, stdout: '', stderr: 'connection refused' });
        }
      }
      return exec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage() {
        return Promise.reject(new Error('not used'));
      },
      resolvePublishedImage() {
        return Promise.resolve('im-built0123');
      },
      publishImageId() {
        return Promise.reject(new Error('not used'));
      },
      createVmSandbox() {
        return Promise.resolve(sandbox);
      },
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await expect(
      publisher.smokeImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
        agentToken: randomUUID(),
        telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ health: { ok: true, details: 'workspace-agent ready' } }),
    );
    expect(healthAttempts).toBe(2);
  });

  test('terminates the VM when a smoke assertion fails', async () => {
    let terminationCount = 0;
    const sandbox = successfulSandbox([], () => {
      terminationCount += 1;
    });
    sandbox.exec = () => Promise.resolve({ exitCode: 0, stdout: 'v21.7.3\n', stderr: '' });
    const sdk: ModalSdkPort = {
      buildImage() {
        return Promise.reject(new Error('not used'));
      },
      resolvePublishedImage() {
        return Promise.resolve('im-built0123');
      },
      publishImageId() {
        return Promise.reject(new Error('not used'));
      },
      createVmSandbox() {
        return Promise.resolve(sandbox);
      },
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await expect(
      publisher.smokeImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
        agentToken: randomUUID(),
        telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
      }),
    ).rejects.toThrow('Expected Node.js 22');
    expect(terminationCount).toBe(1);
  });
});

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.next', '.turbo'].includes(entry.name)) {
          return [];
        }
        return findTypeScriptFiles(path);
      }
      return entry.isFile() && /\.[cm]?ts$/u.test(entry.name) ? [path] : [];
    }),
  );
  return paths.flat();
}

test('the Modal SDK is imported only by the sandbox-service provider boundary', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const roots = ['apps', 'infra', 'packages', 'sandbox', 'services'];
  const files = (
    await Promise.all(roots.map((root) => findTypeScriptFiles(resolve(repositoryRoot, root))))
  ).flat();
  const packageName = ['mo', 'dal'].join('');
  const staticImport = new RegExp(`\\bfrom\\s*['\"]${packageName}['\"]`, 'u');
  const dynamicImport = new RegExp(`\\bimport\\s*\\(\\s*['\"]${packageName}['\"]`, 'u');
  const importers: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (staticImport.test(source) || dynamicImport.test(source)) {
      importers.push(file.slice(repositoryRoot.length + 1));
    }
  }

  expect(importers).toEqual(['services/sandbox-service/src/provider/modal.ts']);
});
