import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  PublishImageInputSchema,
  type ModalImagePublisher,
} from '@zapp/sandbox-service/provider-types';
import {
  ImageLockSchema,
  collectPublishPreflightBlockers,
  parseModalPublishArgs,
  publishImagesTransaction,
} from '../publish.js';

const SOURCE_REVISION = {
  repositoryUrl: 'https://github.com/crossbizz/zapp.git',
  commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
} as const;

function successfulPublisher(
  calls: Array<{ operation: string; input: unknown }>,
): ModalImagePublisher {
  return {
    publishImage(input) {
      calls.push({ operation: 'publish', input });
      return Promise.resolve({
        digest:
          input.imageName === 'forge-node-base'
            ? `im-base-${input.environment}`
            : `im-web-${input.environment}`,
        publishedName: input.publishedName,
      });
    },
    smokeImage(input) {
      calls.push({ operation: 'smoke', input });
      return Promise.resolve({
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
    },
    verifyPublishedImage(input) {
      calls.push({ operation: 'verify', input });
      return Promise.resolve();
    },
  };
}

async function createLockFixture(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'zapp-modal-lock-'));
  const path = join(directory, 'images.lock.json');
  await writeFile(path, contents);
  return path;
}

function transactionInput(
  lockFilePath: string,
  provider: ModalImagePublisher,
  environments: readonly ('dev' | 'staging' | 'prod')[] = ['dev'],
) {
  return {
    environments,
    sourceRevision: SOURCE_REVISION,
    lockFilePath,
    provider,
    buildDate: new Date('2026-08-05T12:00:00.000Z'),
    createAgentToken: randomUUID,
    telemetryEndpoint: 'https://sandbox-service.internal/v1/telemetry',
  } as const;
}

describe('Modal publication CLI contract', () => {
  test('maps scoped and all-environment arguments and rejects unknown values', () => {
    expect(parseModalPublishArgs(['publish', '--env', 'dev'])).toEqual({
      mode: 'publish',
      environments: ['dev'],
    });
    expect(parseModalPublishArgs(['publish'])).toEqual({
      mode: 'publish',
      environments: ['dev', 'staging', 'prod'],
    });
    expect(parseModalPublishArgs(['smoke', '--env', 'prod'])).toEqual({
      mode: 'smoke',
      environments: ['prod'],
    });
    expect(() => parseModalPublishArgs(['publish', '--env', 'qa'])).toThrow(
      'Expected dev, staging, or prod',
    );
    expect(() => parseModalPublishArgs(['publish', '--unknown'])).toThrow('Unknown argument');
  });

  test('rejects malformed immutable tags and provider digests at the lock boundary', () => {
    const validEnvironment = {
      modalEnvironment: 'zapp-dev',
      sourceRevision: SOURCE_REVISION.commitSha,
      tag: '2026-08-05-abcdef0',
      images: {
        'forge-node-base': {
          appName: 'zapp-workspaces',
          digest: 'im-base0123',
          publishedName: 'forge-node-base:2026-08-05-abcdef0',
        },
        'forge-web-test': {
          appName: 'zapp-browser-verify',
          digest: 'im-web0123',
          publishedName: 'forge-web-test:2026-08-05-abcdef0',
        },
      },
    };

    expect(() =>
      ImageLockSchema.parse({
        version: 1,
        environments: { dev: { ...validEnvironment, tag: 'latest' } },
      }),
    ).toThrow();
    expect(() =>
      ImageLockSchema.parse({
        version: 1,
        environments: {
          dev: {
            ...validEnvironment,
            images: {
              ...validEnvironment.images,
              'forge-node-base': {
                ...validEnvironment.images['forge-node-base'],
                digest: '',
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  test('rejects lock records whose environment, app, source, tag, or published names disagree', () => {
    const validEnvironment = {
      modalEnvironment: 'zapp-dev',
      sourceRevision: SOURCE_REVISION.commitSha,
      tag: '2026-08-05-abcdef0',
      images: {
        'forge-node-base': {
          appName: 'zapp-workspaces',
          digest: 'im-base0123',
          publishedName: 'forge-node-base:2026-08-05-abcdef0',
        },
        'forge-web-test': {
          appName: 'zapp-browser-verify',
          digest: 'im-web0123',
          publishedName: 'forge-web-test:2026-08-05-abcdef0',
        },
      },
    } as const;
    const invalidLocks = [
      { dev: { ...validEnvironment, modalEnvironment: 'zapp-prod' } },
      {
        dev: {
          ...validEnvironment,
          images: {
            'forge-node-base': {
              ...validEnvironment.images['forge-node-base'],
              appName: 'zapp-browser-verify',
            },
            'forge-web-test': {
              ...validEnvironment.images['forge-web-test'],
              appName: 'zapp-workspaces',
            },
          },
        },
      },
      { dev: { ...validEnvironment, sourceRevision: `1111111${'0'.repeat(33)}` } },
      {
        dev: {
          ...validEnvironment,
          images: {
            ...validEnvironment.images,
            'forge-node-base': {
              ...validEnvironment.images['forge-node-base'],
              publishedName: 'forge-web-test:2026-08-05-abcdef0',
            },
          },
        },
      },
    ];

    for (const environments of invalidLocks) {
      expect(() => ImageLockSchema.parse({ version: 1, environments })).toThrow();
    }
  });

  test('reports missing credentials and an unpublished source revision as separate blockers', async () => {
    const blockers = await collectPublishPreflightBlockers({
      credentials: {},
      sourceRevision: SOURCE_REVISION,
      isRevisionAdvertised: () => Promise.resolve(false),
    });

    expect(blockers).toEqual([
      'Modal credentials are missing: set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET',
      `Source revision ${SOURCE_REVISION.commitSha} is not advertised by ${SOURCE_REVISION.repositoryUrl}`,
    ]);
  });
});

describe('Modal image publication transaction', () => {
  test('publishes both app targets, smoke-checks the base, and preserves unselected records', async () => {
    const previous = JSON.stringify(
      {
        version: 1,
        environments: {
          staging: {
            modalEnvironment: 'zapp-staging',
            sourceRevision: '1111111111111111111111111111111111111111',
            tag: '2026-08-04-1111111',
            images: {
              'forge-node-base': {
                appName: 'zapp-workspaces',
                digest: 'im-oldbase',
                publishedName: 'forge-node-base:2026-08-04-1111111',
              },
              'forge-web-test': {
                appName: 'zapp-browser-verify',
                digest: 'im-oldweb',
                publishedName: 'forge-web-test:2026-08-04-1111111',
              },
            },
          },
        },
      },
      null,
      2,
    ).concat('\n');
    const lockFilePath = await createLockFixture(previous);
    const calls: Array<{ operation: string; input: unknown }> = [];

    const result = await publishImagesTransaction(
      transactionInput(lockFilePath, successfulPublisher(calls)),
    );

    expect(calls.map(({ operation }) => operation)).toEqual([
      'publish',
      'publish',
      'smoke',
      'verify',
      'verify',
    ]);
    expect(calls[0]?.input).toEqual(
      expect.objectContaining({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        imageName: 'forge-node-base',
        publishedName: 'forge-node-base:2026-08-05-abcdef0',
      }),
    );
    expect(calls[1]?.input).toEqual(
      expect.objectContaining({
        environment: 'zapp-dev',
        appName: 'zapp-browser-verify',
        imageName: 'forge-web-test',
        publishedName: 'forge-web-test:2026-08-05-abcdef0',
      }),
    );
    const webPublication = PublishImageInputSchema.parse(calls[1]?.input);
    expect(webPublication.recipe.base).toEqual({
      kind: 'publication',
      digest: 'im-base-zapp-dev',
    });
    expect(calls[2]?.input).toEqual(
      expect.objectContaining({
        environment: 'zapp-dev',
        appName: 'zapp-workspaces',
        publishedName: 'forge-node-base:2026-08-05-abcdef0',
      }),
    );
    expect(result.environments.staging?.tag).toBe('2026-08-04-1111111');
    expect(result.environments.dev?.images['forge-node-base'].digest).toBe('im-base-zapp-dev');
    expect(ImageLockSchema.parse(JSON.parse(await readFile(lockFilePath, 'utf8')))).toEqual(result);
  });

  test('leaves the lock unchanged when either published name changes after smoke', async () => {
    const original = '{"version":1,"environments":{}}\n';
    const lockFilePath = await createLockFixture(original);
    const calls: Array<{ operation: string; input: unknown }> = [];
    const provider = successfulPublisher(calls);
    provider.verifyPublishedImage = (input) => {
      if (input.publishedName.startsWith('forge-web-test:')) {
        return Promise.reject(
          new Error('Published image name no longer resolves to the expected digest'),
        );
      }
      return Promise.resolve();
    };

    await expect(
      publishImagesTransaction(transactionInput(lockFilePath, provider)),
    ).rejects.toThrow('Published image name no longer resolves to the expected digest');
    expect(await readFile(lockFilePath, 'utf8')).toBe(original);
  });

  test('leaves the lock byte-for-byte unchanged when the second image fails', async () => {
    const original = '{"version":1,"environments":{}}\n';
    const lockFilePath = await createLockFixture(original);
    const provider = successfulPublisher([]);
    let invocation = 0;
    provider.publishImage = (input) => {
      invocation += 1;
      if (invocation === 2) {
        return Promise.reject(new Error('web image failed'));
      }
      return Promise.resolve({ digest: 'im-base-dev', publishedName: input.publishedName });
    };

    await expect(
      publishImagesTransaction(transactionInput(lockFilePath, provider)),
    ).rejects.toThrow('web image failed');
    expect(await readFile(lockFilePath, 'utf8')).toBe(original);
  });

  test('leaves the lock unchanged when a later environment or smoke fails', async () => {
    const original = '{\n  "version": 1,\n  "environments": {}\n}\n';
    const lockFilePath = await createLockFixture(original);
    const provider = successfulPublisher([]);
    provider.smokeImage = (input) => {
      if (input.environment === 'zapp-staging') {
        return Promise.reject(new Error('staging VM smoke failed'));
      }
      return Promise.resolve({
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
    };

    await expect(
      publishImagesTransaction(transactionInput(lockFilePath, provider, ['dev', 'staging'])),
    ).rejects.toThrow('staging VM smoke failed');
    expect(await readFile(lockFilePath, 'utf8')).toBe(original);
  });

  test('serializes concurrent scoped publications without losing either environment record', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void = () => undefined;
    const firstPublicationStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const devPublisher = successfulPublisher([]);
    const publishDev = devPublisher.publishImage.bind(devPublisher);
    let devCalls = 0;
    devPublisher.publishImage = async (input) => {
      devCalls += 1;
      if (devCalls === 1) {
        firstStarted();
        await firstGate;
      }
      return publishDev(input);
    };
    const stagingCalls: Array<{ operation: string; input: unknown }> = [];

    const dev = publishImagesTransaction(transactionInput(lockFilePath, devPublisher, ['dev']));
    await firstPublicationStarted;
    const staging = publishImagesTransaction(
      transactionInput(lockFilePath, successfulPublisher(stagingCalls), ['staging']),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stagingCalls).toHaveLength(0);
    releaseFirst();
    await Promise.all([dev, staging]);

    const locked = ImageLockSchema.parse(JSON.parse(await readFile(lockFilePath, 'utf8')));
    expect(Object.keys(locked.environments).sort()).toEqual(['dev', 'staging']);
  });

  test('releases the adjacent writer lock when publication fails', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const failing = successfulPublisher([]);
    failing.publishImage = () => Promise.reject(new Error('first publication failed'));

    await expect(
      publishImagesTransaction(transactionInput(lockFilePath, failing, ['dev'])),
    ).rejects.toThrow('first publication failed');
    const recovered = await publishImagesTransaction(
      transactionInput(lockFilePath, successfulPublisher([]), ['staging']),
    );
    expect(recovered.environments.staging?.modalEnvironment).toBe('zapp-staging');
    await expect(access(`${lockFilePath}.publish-lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('recovers an abandoned same-host writer lock', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const lockDirectory = `${lockFilePath}.publish-lock`;
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({
        token: randomUUID(),
        pid: 2_147_483_647,
        hostname: hostname(),
      }),
    );
    const old = new Date('2026-08-05T00:00:00.000Z');
    await utimes(lockDirectory, old, old);

    const recovered = await publishImagesTransaction(
      transactionInput(lockFilePath, successfulPublisher([]), ['dev']),
    );
    expect(recovered.environments.dev?.modalEnvironment).toBe('zapp-dev');
    await expect(access(lockDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('retries when a concurrently released writer lock disappears before recovery stat', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const lockDirectory = `${lockFilePath}.publish-lock`;
    await mkdir(lockDirectory);
    let now = Date.now();
    let reachRecoveryStat: () => void = () => undefined;
    const recoveryStatReached = new Promise<void>((resolve) => {
      reachRecoveryStat = resolve;
    });
    let continueRecovery: () => void = () => undefined;
    const recoveryMayContinue = new Promise<void>((resolve) => {
      continueRecovery = resolve;
    });
    const lockTiming = {
      now: () => now,
      wait(milliseconds: number) {
        now += milliseconds;
        return Promise.resolve();
      },
      timeoutMs: 50,
      async beforeRecoveryStat() {
        reachRecoveryStat();
        await recoveryMayContinue;
      },
    };
    const transaction = publishImagesTransaction({
      ...transactionInput(lockFilePath, successfulPublisher([]), ['dev']),
      lockTiming,
    });

    try {
      const firstOutcome = await Promise.race([
        recoveryStatReached.then(() => 'recovery-stat-barrier'),
        transaction.then(
          () => 'transaction-resolved-before-barrier',
          (error: unknown) =>
            error instanceof Error ? `transaction-rejected: ${error.message}` : String(error),
        ),
      ]);
      expect(firstOutcome).toBe('recovery-stat-barrier');

      await rm(lockDirectory, { recursive: true });
      continueRecovery();
      const recovered = await transaction;

      expect(recovered.environments.dev?.modalEnvironment).toBe('zapp-dev');
      await expect(access(lockDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      continueRecovery();
      await transaction.catch(() => undefined);
      await rm(lockDirectory, { recursive: true, force: true });
    }
  });

  test('bounds writer-lock waiting with the injected clock and timeout', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const lockDirectory = `${lockFilePath}.publish-lock`;
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ token: randomUUID(), pid: process.pid, hostname: hostname() }),
    );
    let now = Date.now();
    const waits: number[] = [];
    const transaction = publishImagesTransaction({
      ...transactionInput(lockFilePath, successfulPublisher([]), ['dev']),
      lockTiming: {
        now: () => now,
        wait(milliseconds: number) {
          waits.push(milliseconds);
          now += milliseconds;
          return Promise.resolve();
        },
        timeoutMs: 50,
      },
    });
    const outcome = await Promise.race([
      transaction.then(
        () => 'resolved',
        (error: unknown) => {
          return error instanceof Error ? error.message : String(error);
        },
      ),
      new Promise<string>((resolveOutcome) => {
        setTimeout(() => {
          resolveOutcome('still waiting after injected timeout');
        }, 100);
      }),
    ]);

    if (outcome === 'still waiting after injected timeout') {
      await rm(lockDirectory, { recursive: true, force: true });
      await transaction.catch(() => undefined);
    }
    expect(outcome).toBe('Timed out waiting for Modal image publication lock');
    expect(waits).toEqual([25, 25]);
  });
});
