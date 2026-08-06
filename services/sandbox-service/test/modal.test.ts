import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createModalImagePublisher,
  type ModalSdkPort,
  type ModalSdkSandboxPort,
} from '../src/provider/modal.js';
import { ImageRecipeSchema } from '../src/provider/types.js';

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

function successfulSandbox(commands: string[][], terminate: () => void): ModalSdkSandboxPort {
  return {
    exec(command) {
      commands.push(command);
      if (command[0] === 'node') {
        return Promise.resolve({ exitCode: 0, stdout: 'v22.23.1\n', stderr: '' });
      }
      if (command[0] === 'curl' && command.at(-1)?.endsWith('/healthz')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, details: 'workspace-agent ready' }),
          stderr: '',
        });
      }
      if (command[0] === 'curl') {
        const body = command[command.indexOf('--data') + 1] ?? '';
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
    terminate() {
      terminate();
      return Promise.resolve();
    },
  };
}

describe('Modal image provider facade', () => {
  test('maps project-owned publication input to an immutable SDK build result', async () => {
    const builds: unknown[] = [];
    let closed = false;
    const sdk: ModalSdkPort = {
      buildAndPublish(input) {
        builds.push(input);
        return Promise.resolve('im-built0123');
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
    expect(closed).toBe(true);
  });

  test('requests the V2 VM runtime, proves agent containment, and terminates the sandbox', async () => {
    const commands: string[][] = [];
    const createRequests: unknown[] = [];
    let terminationCount = 0;
    const sdk: ModalSdkPort = {
      buildAndPublish() {
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
    expect(commands).toEqual(
      expect.arrayContaining([
        ['node', '--version'],
        expect.arrayContaining(['curl', 'http://127.0.0.1:8877/healthz']),
        expect.arrayContaining(['sh', '-lc', 'sleep 2; test ! -e /tmp/zapp-cgroup-escape']),
      ]),
    );
    expect(result).toEqual({
      nodeVersion: 'v22.23.1',
      health: { ok: true, details: 'workspace-agent ready' },
      vmRuntime: true,
      cgroup: { delegated: true, kill: true, emptySignal: true },
      terminated: true,
    });
    expect(terminationCount).toBe(1);
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
      buildAndPublish() {
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
      buildAndPublish() {
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
