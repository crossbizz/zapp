import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { newId } from '@zapp/contracts';
import { beforeEach, describe, expect, test, vi } from 'vitest';

interface ModalSdkState {
  createCalls: unknown[][];
  experimentalCreateCalls: unknown[][];
  sandbox: unknown;
  volumeCloseCount: number;
  volumeFromNameCalls: unknown[][];
  volumeMissing: boolean;
}

const modalSdkState = vi.hoisted<ModalSdkState>(() => ({
  createCalls: [],
  experimentalCreateCalls: [],
  sandbox: undefined,
  volumeCloseCount: 0,
  volumeFromNameCalls: [],
  volumeMissing: false,
}));

vi.mock('modal', async (importOriginal) => {
  const actual = await importOriginal();
  if (typeof actual !== 'object' || actual === null) {
    throw new Error('Modal SDK mock could not load the real module');
  }
  const actualModule = actual as Record<string, unknown>;
  const ActualModalClient = actualModule.ModalClient;
  if (typeof ActualModalClient !== 'function') {
    throw new Error('Modal SDK mock could not load ModalClient');
  }
  const ModalClientConstructor = ActualModalClient as new (options: {
    tokenId: string;
    tokenSecret: string;
  }) => unknown;

  class MockModalClient {
    readonly apps = {
      fromName: () => Promise.resolve({ appId: 'ap-test' }),
    };

    readonly images = {
      fromId: (imageId: string) =>
        Promise.resolve({
          imageId,
          build: () => Promise.resolve(),
        }),
      fromName: () => Promise.resolve({ imageId: 'im-built0123' }),
    };

    readonly volumes = {
      ephemeral: () =>
        Promise.resolve({
          closeEphemeral() {
            modalSdkState.volumeCloseCount += 1;
          },
        }),
      fromName: (...args: unknown[]) => {
        modalSdkState.volumeFromNameCalls.push(args);
        if (modalSdkState.volumeMissing) {
          const error = new Error('volume not found');
          error.name = 'NotFoundError';
          return Promise.reject(error);
        }
        return Promise.resolve({
          withMountOptions: (options: unknown) => options,
        });
      },
    };

    readonly sandboxes = {
      fromId: () => Promise.resolve(modalSdkState.sandbox),
      create: (...args: unknown[]) => {
        modalSdkState.createCalls.push(args);
        return Promise.resolve(modalSdkState.sandbox);
      },
      experimentalCreate: async (...args: unknown[]) => {
        modalSdkState.experimentalCreateCalls.push(args);
        const untrustedClient = new ModalClientConstructor({
          tokenId: 'test-modal-id',
          tokenSecret: 'test-modal-secret',
        });
        const client = untrustedClient as {
          sandboxes: {
            experimentalCreate: (...parameters: unknown[]) => Promise<unknown>;
          };
          close(): void;
        };
        try {
          return await client.sandboxes.experimentalCreate(...args);
        } finally {
          client.close();
        }
      },
    };

    close() {}
  }

  return {
    ...actualModule,
    ModalClient: MockModalClient,
  };
});
import {
  createModalNightlyE2eDriver,
  createModalSandboxProvider,
  createModalImagePublisher,
  imageDockerfileCommands,
  type ModalSdkPort,
  type ModalSdkSandboxPort,
} from '../src/provider/modal.js';
import {
  AgentHealthSchema,
  ImageRecipeSchema,
  SmokeImageInputSchema,
} from '../src/provider/types.js';

const TAG = '2026-08-05-abcdef0';

function baseRecipe() {
  return ImageRecipeSchema.parse({
    imageName: 'forge-node-base',
    base: {
      kind: 'registry',
      ref: 'node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
    },
    layers: [{ kind: 'plain', commands: ['RUN node --version'] }],
    files: [],
  });
}

interface StatefulSandboxOptions {
  readonly cleanupFailureStage?: 'kill' | 'populated_wait' | 'remove';
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
      if (command[0] === 'curl' && url.endsWith('/__zapp/healthz')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ status: 'ok' }),
          stderr: '',
        });
      }
      if (command[0] === 'curl' && url.endsWith('/healthz')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            details: 'workspace-agent ready',
            devServer: null,
          }),
          stderr: '',
        });
      }
      if (command[0] === 'curl' && url.includes('/exec/cleanup/')) {
        const cleanupId = url.split('/').at(-1) ?? '';
        if (options.cleanupFailureStage !== undefined || !cleanupIds.has(cleanupId)) {
          return Promise.resolve({
            exitCode: 22,
            stdout: JSON.stringify({
              error: 'containment_cleanup_failed',
              stage: options.cleanupFailureStage ?? 'remove',
            }),
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

function sdkSandbox(sandbox: ModalSdkSandboxPort) {
  return {
    async exec(command: string[]) {
      const result = await sandbox.exec(command);
      return {
        stdout: { readText: () => Promise.resolve(result.stdout) },
        stderr: { readText: () => Promise.resolve(result.stderr) },
        wait: () => Promise.resolve(result.exitCode),
      };
    },
    waitUntilReady: (timeoutMs: number) => sandbox.waitUntilReady(timeoutMs),
    tunnels: (timeoutMs: number) => sandbox.tunnels(timeoutMs),
    async snapshotFilesystem(input: { timeoutMs: number; ttlMs: number }) {
      return { imageId: await sandbox.snapshotFilesystem(input) };
    },
    terminate: () => sandbox.terminate(),
  };
}

function runDash(script: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn('/bin/dash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectExecution);
    child.once('exit', (status) => {
      resolveExecution({ status: status ?? 127, stdout, stderr });
    });
  });
}

beforeEach(() => {
  modalSdkState.createCalls.length = 0;
  modalSdkState.experimentalCreateCalls.length = 0;
  modalSdkState.sandbox = undefined;
  modalSdkState.volumeCloseCount = 0;
  modalSdkState.volumeFromNameCalls.length = 0;
  modalSdkState.volumeMissing = false;
});

describe('Modal workspace agent adapter', () => {
  test('does not create an absent project volume during a read-only billing probe', async () => {
    modalSdkState.volumeMissing = true;
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: {
        version: 1,
        environments: {
          dev: {
            modalEnvironment: 'zapp-dev',
            sourceRevision: 'c58a416cba65f57ea64ba3e3e90f3646efca9b62',
            tag: '2026-08-08-c58a416',
            images: {
              'forge-node-base': {
                appName: 'zapp-workspaces',
                digest: 'im-9NCxx8merCgh67jj0YLM84',
                publishedName: 'forge-node-base:2026-08-08-c58a416',
              },
              'forge-web-test': {
                appName: 'zapp-browser-verify',
                digest: 'im-eVxjg43Gv7bQrkH0CbwrrX',
                publishedName: 'forge-web-test:2026-08-08-c58a416',
              },
            },
          },
        },
      },
      agentToken: 'agent-test-token',
      credentials: { tokenId: 'test-modal-id', tokenSecret: 'test-modal-secret' },
    });

    await expect(
      provider.measureProjectVolumeBytes({
        organizationId: newId('org'),
        projectId: newId('proj'),
      }),
    ).resolves.toBe('0');
    expect(modalSdkState.volumeFromNameCalls).toEqual([
      [expect.stringMatching(/^vol-proj_/u), { environment: 'zapp-dev', createIfMissing: false }],
    ]);
    expect(modalSdkState.createCalls).toHaveLength(0);
  });

  test('streams an allowed 8 MiB agent envelope through stdin instead of one argv entry', async () => {
    let command: string[] = [];
    let stdin = '';
    let stdinClosed = false;
    let stdinClosedAt = -1;
    let writerLockReleased = false;
    let errorRecoveryCloseCalls = 0;
    const responseBody = Buffer.from(JSON.stringify({ ok: true }));
    modalSdkState.sandbox = {
      sandboxId: 'sb-envelope-stdin',
      poll: () => Promise.resolve(null),
      exec(nextCommand: string[]) {
        command = nextCommand;
        if (nextCommand.some((argument) => Buffer.byteLength(argument) > 128 * 1_024)) {
          const error = new Error('argument list too long');
          Object.assign(error, { code: 'E2BIG' });
          return Promise.reject(error);
        }
        return Promise.resolve({
          stdin: {
            writeText(value: string) {
              stdin = value;
              return Promise.resolve();
            },
            getWriter() {
              return {
                write(value: string) {
                  stdin += value;
                  return Promise.resolve();
                },
                close() {
                  stdinClosedAt = Buffer.byteLength(stdin);
                  stdinClosed = true;
                  return Promise.resolve();
                },
                releaseLock() {
                  writerLockReleased = true;
                },
              };
            },
          },
          closeStdin() {
            errorRecoveryCloseCalls += 1;
            return Promise.reject(new Error('closeStdin is error recovery only'));
          },
          stdout: {
            readText: () =>
              Promise.resolve(
                JSON.stringify({
                  statusCode: 200,
                  contentType: 'application/json; charset=utf-8',
                  bodyBase64: responseBody.toString('base64'),
                }),
              ),
          },
          stderr: { readText: () => Promise.resolve('') },
          wait: () => Promise.resolve(stdinClosed ? 0 : 1),
        });
      },
    };
    const provider = createModalSandboxProvider({
      environment: 'dev',
      imageLock: {
        version: 1,
        environments: {
          dev: {
            modalEnvironment: 'zapp-dev',
            sourceRevision: 'c58a416cba65f57ea64ba3e3e90f3646efca9b62',
            tag: '2026-08-08-c58a416',
            images: {
              'forge-node-base': {
                appName: 'zapp-workspaces',
                digest: 'im-9NCxx8merCgh67jj0YLM84',
                publishedName: 'forge-node-base:2026-08-08-c58a416',
              },
              'forge-web-test': {
                appName: 'zapp-browser-verify',
                digest: 'im-eVxjg43Gv7bQrkH0CbwrrX',
                publishedName: 'forge-web-test:2026-08-08-c58a416',
              },
            },
          },
        },
      },
      agentToken: 'agent-test-token',
      credentials: { tokenId: 'test-modal-id', tokenSecret: 'test-modal-secret' },
    });

    await expect(
      provider.writeFilesAtomically('sb-envelope-stdin', [
        { path: 'large.bin', data: Buffer.alloc(8 * 1_024 * 1_024, 'a') },
      ]),
    ).resolves.toBeUndefined();

    expect(command).toHaveLength(4);
    expect(command.slice(0, 3)).toEqual(['node', '--input-type=module', '-e']);
    expect(Math.max(...command.map((argument) => Buffer.byteLength(argument)))).toBeLessThan(
      128 * 1_024,
    );
    expect(stdinClosed).toBe(true);
    expect(stdinClosedAt).toBe(Buffer.byteLength(stdin));
    expect(writerLockReleased).toBe(true);
    expect(errorRecoveryCloseCalls).toBe(0);
    const envelope = JSON.parse(Buffer.from(stdin, 'base64').toString('utf8')) as {
      method: string;
      url: string;
      headers: Record<string, string>;
      bodyBase64: string;
    };
    expect(envelope.method).toBe('POST');
    expect(envelope.url).toBe('http://127.0.0.1:8877/files/atomic-write');
    expect(envelope.headers.authorization).toBe('Bearer agent-test-token');
    const body = JSON.parse(Buffer.from(envelope.bodyBase64, 'base64').toString('utf8')) as {
      files: Array<{ path: string; dataBase64: string }>;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.path).toBe('large.bin');
    expect(
      Buffer.from(body.files[0]?.dataBase64 ?? '', 'base64').equals(
        Buffer.alloc(8 * 1_024 * 1_024, 'a'),
      ),
    ).toBe(true);
  });
});

describe('Modal image provider facade', () => {
  test('restores a snapshot using the strict workspace volume identity', async () => {
    modalSdkState.sandbox = { sandboxId: 'sb-restored' };
    const imageLock = {
      version: 1,
      environments: {
        dev: {
          modalEnvironment: 'zapp-dev',
          sourceRevision: 'c58a416cba65f57ea64ba3e3e90f3646efca9b62',
          tag: '2026-08-08-c58a416',
          images: {
            'forge-node-base': {
              appName: 'zapp-workspaces',
              digest: 'im-9NCxx8merCgh67jj0YLM84',
              publishedName: 'forge-node-base:2026-08-08-c58a416',
            },
            'forge-web-test': {
              appName: 'zapp-browser-verify',
              digest: 'im-eVxjg43Gv7bQrkH0CbwrrX',
              publishedName: 'forge-web-test:2026-08-08-c58a416',
            },
          },
        },
      },
    } as const;
    const workspace = {
      organizationId: newId('org'),
      projectId: newId('proj'),
      branchId: newId('br'),
      runId: newId('run'),
      taskId: newId('task'),
      purpose: 'builder',
      resourceProfile: 'standard',
      imageTag: imageLock.environments.dev.images['forge-node-base'].publishedName,
      env: {},
      networkProfile: 'dependency_install',
    } as const;
    const driver = createModalNightlyE2eDriver({
      environment: 'dev',
      imageLock,
      agentToken: 'agent-test-token',
      credentials: { tokenId: 'test-modal-id', tokenSecret: 'test-modal-secret' },
    });

    await expect(
      driver.restoreSnapshot({ snapshotDigest: 'im-snapshot0123', workspace }),
    ).resolves.toBe('sb-restored');

    expect(modalSdkState.createCalls).toHaveLength(1);
    const createOptions = modalSdkState.createCalls[0]?.[2] as {
      readonly env: Readonly<Record<string, string>>;
      readonly tags: Readonly<Record<string, string>>;
      readonly volumes: Readonly<Record<string, unknown>>;
    };
    expect(createOptions.env.ZAPP_WORKSPACE_ROOT).toBe(`/workspace/${workspace.branchId}`);
    expect(createOptions.tags).toMatchObject({
      org_id: workspace.organizationId,
      project_id: workspace.projectId,
      branch_id: workspace.branchId,
      run_id: workspace.runId,
      task_id: workspace.taskId,
    });
    expect(createOptions.volumes).toEqual({ '/cache': { subPath: '/cache' } });
    driver.close();
  });

  test('creates the VM-runtime sandbox atomically with all seven tags', async () => {
    const commands: string[][] = [];
    modalSdkState.sandbox = sdkSandbox(successfulSandbox(commands, () => undefined));
    const publisher = createModalImagePublisher({
      credentials: { tokenId: 'test-modal-id', tokenSecret: 'test-modal-secret' },
    });

    await publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
      telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
    });

    expect(modalSdkState.experimentalCreateCalls).toHaveLength(0);
    expect(modalSdkState.createCalls).toHaveLength(1);
    expect(modalSdkState.createCalls[0]?.[2]).toEqual(
      expect.objectContaining({
        tags: {
          org_id: 'smoke_org_ws_2',
          project_id: 'smoke_project_ws_2',
          branch_id: 'smoke_branch_ws_2',
          run_id: 'smoke_run_ws_2',
          task_id: 'smoke_task_ws_2',
          purpose: 'image_smoke',
          environment: 'zapp-dev',
        },
        experimentalOptions: { vm_runtime: true },
      }),
    );
    expect(modalSdkState.volumeCloseCount).toBe(1);
  });

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
        layers: [{ kind: 'plain', commands: ['RUN npm ci --prefix /opt/zapp/browser'] }],
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
        encryptedPorts: [8877, 8080],
        readinessProbe: { kind: 'tcp', port: 8877, intervalMs: 250 },
        volumeMountPath: '/workspace-probe',
        tags: {
          org_id: 'smoke_org_ws_2',
          project_id: 'smoke_project_ws_2',
          branch_id: 'smoke_branch_ws_2',
          run_id: 'smoke_run_ws_2',
          task_id: 'smoke_task_ws_2',
          purpose: 'image_smoke',
          environment: 'zapp-dev',
        },
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
      '/__zapp/healthz',
      '/workspace-probe',
      '/exec/cleanup/',
      'ZAPP_GITHUB_READ_TOKEN',
      '${GIT_ASKPASS+x}',
      '${GIT_CONFIG_GLOBAL+x}',
      '${GIT_CONFIG_SYSTEM+x}',
      '/tmp/zapp-source-fetch/askpass',
      '/root/.git-credentials',
      '/proc/[0-9]*/environ',
      'git config --system',
      'core\\.[Aa]sk[Pp]ass',
      'gitleaks git',
      'semgrep --version',
      'knip --version',
      'jscpd --version',
      'eslint --version',
      'osv-scanner scan source',
      '--offline',
      'package-lock.json',
      'node_modules/zapp-osv-smoke-dependency',
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
      expect(script.match(/jq -ser/gu)?.length).toBeGreaterThanOrEqual(2);
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
      health: { ok: true, details: 'workspace-agent ready', devServer: null },
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
        previewProxyHealth: true,
        volumeReadWrite: true,
        filesystemSnapshot: 'im-snapshot0123',
        encryptedTunnel: true,
        readinessProbe: true,
        gitleaksSecretScan: true,
        antiSlopToolchain: true,
        dependencyScan: true,
      },
      credentialAbsence: {
        environment: true,
        gitConfiguration: true,
        askpassPath: true,
        processEnvironment: true,
      },
      terminated: true,
    });
    expect(terminationCount).toBe(1);
  });

  test('streams started to the live explicit-kill probe before the response completes', async () => {
    const commands: string[][] = [];
    const sandbox = successfulSandbox(commands, () => undefined);
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });
    await publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
    });

    const script = commands.find(
      (command) =>
        command[0] === 'sh' &&
        command[1] === '-lc' &&
        command[2]?.includes('/tmp/zapp-explicit-kill-buffered.ndjson') &&
        command[2].includes('request_pid=$!'),
    )?.[2];
    expect(script).toBeDefined();

    const events: string[] = [];
    let streamResponse: ServerResponse | undefined;
    const server = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        if (request.url?.startsWith('/exec?stream=1')) {
          events.push('stream_started');
          streamResponse = response;
          response.on('error', () => undefined);
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          response.flushHeaders();
          response.write(
            `${JSON.stringify({
              type: 'started',
              pid: 4242,
              executionId: 'execution-curl-buffer-sentinel',
            })}\n`,
          );
          return;
        }
        if (request.url === '/exec/4242/kill') {
          events.push('kill_requested');
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"killed":true}\n');
          streamResponse?.write('{"type":"exit","exitCode":143}\n');
          streamResponse?.end();
          events.push('stream_completed');
          return;
        }
        response.writeHead(404);
        response.end();
      });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(8877, '127.0.0.1', resolveListen);
    });
    try {
      const fastScript = (script ?? '').replace(
        'sleep 30 & start_deadline_pid=$!',
        'sleep 5 & start_deadline_pid=$!',
      );
      const execution = await runDash(fastScript);
      expect(execution.status, `${execution.stdout}\n${execution.stderr}`).toBe(0);
      expect(events).toEqual(['stream_started', 'kill_requested', 'stream_completed']);
    } finally {
      streamResponse?.destroy();
      await new Promise<void>((resolveClose) =>
        server.close(() => {
          resolveClose();
        }),
      );
    }
  }, 15_000);

  test('disables buffering for every emitted background NDJSON consumer', async () => {
    const commands: string[][] = [];
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(successfulSandbox(commands, () => undefined)),
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });
    await publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
    });

    const backgroundStreams = commands
      .filter((command) => command[0] === 'sh' && command[1] === '-lc')
      .flatMap((command) => {
        const script = command[2] ?? '';
        return [...script.matchAll(/& request(?:_b)?_pid=\$!/gu)].map((match) => {
          const requestEnd = match.index + match[0].length;
          return script.slice(script.lastIndexOf('curl ', match.index), requestEnd);
        });
      })
      .filter((request) => request.includes('stream=1'));
    expect(backgroundStreams).toHaveLength(5);
    for (const request of backgroundStreams) {
      expect(request).toContain('--no-buffer');
    }
  });

  test('emits fail-fast smoke scripts that execute under Debian dash', async () => {
    const commands: string[][] = [];
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () =>
        Promise.resolve(successfulSandbox(commands, () => undefined)),
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    await publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
    });

    const scripts = commands.filter(
      (command) => command[0] === 'sh' && command[1] === '-lc' && command[2]?.startsWith('set -'),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const command of scripts) {
      const script = command[2] ?? '';
      const syntax = spawnSync('/bin/dash', ['-n', '-c', script], { encoding: 'utf8' });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(script).not.toMatch(/\bjq\b[^;]*\|\s*(?:head|tail)\b/u);
      const jqAssignments = script
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => /\w+=\$\(jq\s/u.test(statement));
      for (const assignment of jqAssignments) {
        const jqFailure = spawnSync(
          '/bin/dash',
          [
            '-c',
            `jq() { printf 'partial-value'; return 7; }; set -eu; ${assignment}; printf 'continued'`,
          ],
          { encoding: 'utf8' },
        );
        expect(jqFailure.status, jqFailure.stderr).toBe(7);
        expect(jqFailure.stdout).not.toContain('continued');
      }

      const failFastPreamble = script.slice(0, script.indexOf(';'));
      const execution = spawnSync('/bin/dash', ['-c', `${failFastPreamble}; exit 0`], {
        encoding: 'utf8',
      });
      expect(execution.status, execution.stderr).toBe(0);
    }
  });

  test('observes an explicit-kill started record after the old polling boundary', async () => {
    const commands: string[][] = [];
    const sandbox = successfulSandbox(commands, () => undefined);
    const defaultExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      const script = command[2] ?? '';
      if (
        command[0] === 'sh' &&
        command[1] === '-lc' &&
        script.includes('/tmp/zapp-explicit-kill-buffered.ndjson') &&
        script.includes('request_pid=$!')
      ) {
        await defaultExec(command);
        const fakeCommands = `
observation_count=0
curl() {
  case "$*" in
    */kill*) printf '%s\\n' '{"killed":true}' ;;
  esac
}
grep() {
  observation_count=$((observation_count + 1))
  if [ "$observation_count" -eq 201 ]; then
    printf '%s\\n' '{"type":"started","pid":4242,"executionId":"execution-boundary-sentinel"}' '{"type":"exit","exitCode":143}' > /tmp/zapp-explicit-kill-buffered.ndjson
    return 0
  fi
  return 1
}
sleep() { :; }
kill() {
  case "$1" in
    -0) return 0 ;;
    *) return 9 ;;
  esac
}
jq() {
  case "$*" in
    *.pid*) printf '%s\\n' '4242' ;;
    *.executionId*) printf '%s\\n' 'execution-boundary-sentinel' ;;
    *.killed*) printf '%s\\n' 'true' ;;
    *.exitCode*) printf '%s\\n' '143' ;;
    *) return 9 ;;
  esac
}
`;
        const execution = spawnSync('/bin/dash', ['-c', `${fakeCommands}\n${script}`], {
          encoding: 'utf8',
        });
        return {
          exitCode: execution.status ?? 127,
          stdout: execution.stdout,
          stderr: execution.stderr,
        };
      }
      return defaultExec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
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
      }),
    ).resolves.toEqual(expect.objectContaining({ terminated: true }));
  });

  test('surfaces request completion before explicit-kill started observation', async () => {
    const commands: string[][] = [];
    const sandbox = successfulSandbox(commands, () => undefined);
    const defaultExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      const script = command[2] ?? '';
      if (
        command[0] === 'sh' &&
        command[1] === '-lc' &&
        script.includes('/tmp/zapp-explicit-kill-buffered.ndjson') &&
        script.includes('request_pid=$!')
      ) {
        const fakeCommands = `
curl() { return 0; }
grep() { return 1; }
kill() {
  if [ "$1" = '-0' ]; then
    test "$2" != "$request_pid"
    return
  fi
  return 9
}
sleep() { return 77; }
`;
        const execution = spawnSync('/bin/dash', ['-c', `${fakeCommands}\n${script}`], {
          encoding: 'utf8',
        });
        return {
          exitCode: execution.status ?? 127,
          stdout: execution.stdout,
          stderr: execution.stderr,
        };
      }
      return defaultExec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
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
      }),
    ).rejects.toThrow(
      'explicit-kill-buffered cleanup probe failed with exit code 1 (phase: request_completed_before_started)',
    );
  });

  test('preserves started-wait when the explicit-kill request completes at the deadline', async () => {
    const commands: string[][] = [];
    const sandbox = successfulSandbox(commands, () => undefined);
    const defaultExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      const script = command[2] ?? '';
      if (
        command[0] === 'sh' &&
        command[1] === '-lc' &&
        script.includes('/tmp/zapp-explicit-kill-buffered.ndjson') &&
        script.includes('request_pid=$!')
      ) {
        const fakeCommands = `
poll_count=0
curl() { return 0; }
grep() { return 1; }
seq() { printf '%s\\n' '0' '1200'; }
kill() {
  if [ "$1" = '-0' ]; then
    test "$poll_count" -eq 0
    return
  fi
  return 9
}
sleep() { poll_count=$((poll_count + 1)); }
`;
        const execution = spawnSync('/bin/dash', ['-c', `${fakeCommands}\n${script}`], {
          encoding: 'utf8',
        });
        return {
          exitCode: execution.status ?? 127,
          stdout: execution.stdout,
          stderr: execution.stderr,
        };
      }
      return defaultExec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
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
      }),
    ).rejects.toThrow(
      'explicit-kill-buffered cleanup probe failed with exit code 1 (phase: started_wait)',
    );
  });

  test('surfaces the closed kill-acknowledgement phase from the explicit-kill dash script', async () => {
    const commands: string[][] = [];
    const sandbox = successfulSandbox(commands, () => undefined);
    const defaultExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      const script = command[2] ?? '';
      if (
        command[0] === 'sh' &&
        command[1] === '-lc' &&
        script.includes('/tmp/zapp-explicit-kill-buffered.ndjson') &&
        script.includes('request_pid=$!')
      ) {
        const fakeCommands = `
curl() {
  case "$*" in
    */kill*) printf '%s\\n' '{"killed":false}' ;;
    *) printf '%s\\n' '{"type":"started","pid":4242,"executionId":"execution-diagnostic-sentinel"}' '{"type":"exit","exitCode":143}' ;;
  esac
}
jq() {
  case "$*" in
    *.pid*) printf '%s\\n' '4242' ;;
    *.executionId*) printf '%s\\n' 'execution-diagnostic-sentinel' ;;
    *.killed*) printf '%s\\n' 'false' ;;
    *.exitCode*) printf '%s\\n' '143' ;;
    *) return 9 ;;
  esac
}
`;
        const execution = spawnSync('/bin/dash', ['-c', `${fakeCommands}\n${script}`], {
          encoding: 'utf8',
        });
        return {
          exitCode: execution.status ?? 127,
          stdout: execution.stdout,
          stderr: execution.stderr,
        };
      }
      return defaultExec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });
    const agentToken = randomUUID();

    const smoke = publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken,
    });

    await expect(smoke).rejects.toThrow(
      'explicit-kill-buffered cleanup probe failed with exit code 1 (phase: kill_acknowledgement)',
    );
    await expect(smoke).rejects.not.toThrow(agentToken);
    await expect(smoke).rejects.not.toThrow('execution-diagnostic-sentinel');
  });

  test.each([
    JSON.stringify({ phase: 'kill_acknowledgement', token: 'diagnostic-secret-sentinel' }),
    JSON.stringify({ phase: 'unbounded-diagnostic-sentinel' }),
  ])('rejects a non-closed explicit-kill diagnostic object', async (stdout) => {
    const sandbox = successfulSandbox([], () => undefined);
    const defaultExec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command) => {
      const script = command[2] ?? '';
      if (
        command[0] === 'sh' &&
        command[1] === '-lc' &&
        script.includes('/tmp/zapp-explicit-kill-buffered.ndjson') &&
        script.includes('request_pid=$!')
      ) {
        return Promise.resolve({ exitCode: 9, stdout, stderr: 'raw-stderr-sentinel' });
      }
      return defaultExec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    const error = await publisher
      .smokeImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
        agentToken: randomUUID(),
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'explicit-kill-buffered cleanup probe failed with exit code 9',
    );
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

  test.each(['kill', 'populated_wait', 'remove'] as const)(
    'fails closed while surfacing the exact %s cleanup stage',
    async (stage) => {
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
        return Promise.resolve(
          successfulSandbox([], () => undefined, { cleanupFailureStage: stage }),
        );
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
    ).rejects.toThrow(`containment cleanup acknowledgement failed (stage: ${stage})`);
    },
  );

  test('retries the authenticated health probe while the baked agent is starting', async () => {
    let healthAttempts = 0;
    const sandbox = successfulSandbox([], () => undefined);
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command) => {
      if (
        command[0] === 'curl' &&
        command.at(-1)?.endsWith('/healthz') &&
        !command.at(-1)?.endsWith('/__zapp/healthz')
      ) {
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
      expect.objectContaining({
        health: { ok: true, details: 'workspace-agent ready', devServer: null },
      }),
    );
    expect(healthAttempts).toBe(2);
  });

  test('retries the preview proxy health probe after agent readiness', async () => {
    let previewAttempts = 0;
    const sandbox = successfulSandbox([], () => undefined);
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command) => {
      if (command[0] === 'curl' && command.at(-1)?.endsWith('/__zapp/healthz')) {
        previewAttempts += 1;
        if (previewAttempts === 1) {
          return Promise.resolve({ exitCode: 7, stdout: '', stderr: 'connection refused' });
        }
      }
      return exec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
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
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        health: { ok: true, details: 'workspace-agent ready', devServer: null },
      }),
    );
    expect(previewAttempts).toBe(2);
  });

  test('bounds a stalled preview proxy probe by the remaining readiness deadline', async () => {
    let clockMs = 0;
    let terminationCount = 0;
    const maxTimes: string[] = [];
    const sleep = vi.fn(() => Promise.resolve());
    const sandbox = successfulSandbox([], () => {
      terminationCount += 1;
    });
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command) => {
      if (command[0] === 'curl' && command.at(-1)?.endsWith('/__zapp/healthz')) {
        const maxTimeIndex = command.indexOf('--max-time');
        const maxTime = command[maxTimeIndex + 1];
        if (maxTime === undefined) throw new Error('preview curl max-time missing');
        maxTimes.push(maxTime);
        clockMs += Number.parseFloat(maxTime) * 1_000;
        return Promise.resolve({ exitCode: 28, stdout: '', stderr: 'timed out' });
      }
      return exec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
      close() {},
    };
    const publisher = createModalImagePublisher({
      sdkFactory: () => sdk,
      clockMs: () => clockMs,
      sleep,
    });

    await expect(
      publisher.smokeImage({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        digest: 'im-built0123',
        publishedName: `forge-node-base:${TAG}`,
        agentToken: randomUUID(),
      }),
    ).rejects.toThrow(
      'preview proxy health probe exited 28 before the 30 second readiness deadline',
    );
    expect(maxTimes).toEqual(['30.000']);
    expect(sleep).not.toHaveBeenCalled();
    expect(terminationCount).toBe(1);
  });

  test.each([
    {
      state: 'locked c58 legacy idle',
      health: {
        ok: true,
        details: 'workspace-agent ready',
      },
      expected: {
        ok: true,
        details: 'workspace-agent ready',
        devServer: null,
      },
    },
    {
      state: 'idle',
      health: {
        ok: true,
        details: 'workspace-agent ready',
        devServer: null,
      },
      expected: {
        ok: true,
        details: 'workspace-agent ready',
        devServer: null,
      },
    },
    {
      state: 'managed dev server running',
      health: {
        ok: true,
        details: 'workspace-agent ready',
        devServer: {
          port: 3000,
          pid: 4242,
          supervisorId: 'dev-server-1',
          owned: true,
          httpReady: true,
        },
      },
      expected: {
        ok: true,
        details: 'workspace-agent ready',
        devServer: {
          port: 3000,
          pid: 4242,
          supervisorId: 'dev-server-1',
          owned: true,
          httpReady: true,
        },
      },
    },
  ])(
    'accepts and preserves the exact $state workspace-agent health response',
    async ({ health, expected }) => {
    let healthAttempts = 0;
    const sandbox = successfulSandbox([], () => undefined);
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command) => {
      if (
        command[0] === 'curl' &&
        command.at(-1)?.endsWith('/healthz') &&
        !command.at(-1)?.endsWith('/__zapp/healthz')
      ) {
        healthAttempts += 1;
        if (healthAttempts === 1) {
          return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(health), stderr: '' });
        }
      }
      return exec(command);
    };
    const sdk: ModalSdkPort = {
      buildImage: () => Promise.reject(new Error('not used')),
      resolvePublishedImage: () => Promise.resolve('im-built0123'),
      publishImageId: () => Promise.reject(new Error('not used')),
      createVmSandbox: () => Promise.resolve(sandbox),
      close() {},
    };
    const publisher = createModalImagePublisher({ sdkFactory: () => sdk });

    const evidence = await publisher.smokeImage({
      environment: 'zapp-dev',
      appName: 'zapp-workspaces',
      digest: 'im-built0123',
      publishedName: `forge-node-base:${TAG}`,
      agentToken: randomUUID(),
      telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
    });

      expect(evidence.health).toEqual(expected);
      expect(healthAttempts).toBe(1);
    },
  );

  test('keeps publisher health evidence strict at both object boundaries', () => {
    const running = {
      ok: true,
      details: 'workspace-agent ready',
      devServer: {
        port: 3000,
        pid: 4242,
        supervisorId: 'dev-server-1',
        owned: true,
        httpReady: true,
      },
    } as const;

    expect(AgentHealthSchema.safeParse({ ...running, unexpected: true }).success).toBe(false);
    expect(
      AgentHealthSchema.safeParse({
        ...running,
        devServer: { ...running.devServer, unexpected: true },
      }).success,
    ).toBe(false);
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
}, 15_000);
