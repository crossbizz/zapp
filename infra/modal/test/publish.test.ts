import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
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

const filesystemTestHooks = vi.hoisted(
  (): {
    afterStat?: ((path: string) => Promise<void>) | undefined;
    beforeWriteFile?: ((path: string) => Promise<void>) | undefined;
  } => ({}),
);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async writeFile(
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) {
      if (typeof path === 'string') await filesystemTestHooks.beforeWriteFile?.(path);
      return actual.writeFile(path, data, options);
    },
    async stat(path: Parameters<typeof actual.stat>[0]) {
      const result = await actual.stat(path);
      await filesystemTestHooks.afterStat?.(String(path));
      return result;
    },
  };
});

const SOURCE_REVISION = {
  repositoryUrl: 'https://github.com/crossbizz/zapp.git',
  commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
} as const;

const SUCCESSFUL_SMOKE_EVIDENCE = {
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
    previewProxyHealth: true,
    volumeReadWrite: true,
    filesystemSnapshot: 'im-snapshot0123',
    encryptedTunnel: true,
    readinessProbe: true,
  },
  credentialAbsence: {
    environment: true,
    gitConfiguration: true,
    askpassPath: true,
    processEnvironment: true,
  },
  terminated: true,
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
      return Promise.resolve(SUCCESSFUL_SMOKE_EVIDENCE);
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
      return Promise.resolve(SUCCESSFUL_SMOKE_EVIDENCE);
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

  test('never removes a successor lock when initialization and recovery interleave', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const lockDirectory = `${lockFilePath}.publish-lock`;
    const ownerPath = join(lockDirectory, 'owner.json');
    let releaseFirstOwnerWrite: () => void = () => undefined;
    const firstOwnerWriteMayContinue = new Promise<void>((resolve) => {
      releaseFirstOwnerWrite = resolve;
    });
    let firstOwnerWriteReached: () => void = () => undefined;
    const firstOwnerWriteObserved = new Promise<void>((resolve) => {
      firstOwnerWriteReached = resolve;
    });
    let ownerWriteCount = 0;
    filesystemTestHooks.beforeWriteFile = async (path) => {
      if (!/\.publish-lock(?:\.(?:initializing|owner)\.[^/]+)?\/owner\.json$/u.test(path)) {
        return;
      }
      ownerWriteCount += 1;
      if (ownerWriteCount === 1) {
        firstOwnerWriteReached();
        await firstOwnerWriteMayContinue;
      }
    };

    let releaseFirstWait: () => void = () => undefined;
    const firstWaitMayContinue = new Promise<void>((resolve) => {
      releaseFirstWait = resolve;
    });
    let firstWaitReached: () => void = () => undefined;
    const firstWaitObserved = new Promise<void>((resolve) => {
      firstWaitReached = resolve;
    });
    const first = publishImagesTransaction({
      ...transactionInput(lockFilePath, successfulPublisher([]), ['dev']),
      lockTiming: {
        now: Date.now,
        async wait() {
          firstWaitReached();
          await firstWaitMayContinue;
        },
        timeoutMs: 5_000,
      },
    });
    const firstOutcome = first.then(
      () => 'resolved',
      (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
    );

    await firstOwnerWriteObserved;
    let releaseSecondPublish: () => void = () => undefined;
    const secondPublishMayContinue = new Promise<void>((resolve) => {
      releaseSecondPublish = resolve;
    });
    let secondPublishStarted: () => void = () => undefined;
    const secondPublishing = new Promise<void>((resolve) => {
      secondPublishStarted = resolve;
    });
    const secondPublisher = successfulPublisher([]);
    const publishSecond = secondPublisher.publishImage.bind(secondPublisher);
    let secondPublishCalls = 0;
    secondPublisher.publishImage = async (input) => {
      secondPublishCalls += 1;
      if (secondPublishCalls === 1) {
        secondPublishStarted();
        await secondPublishMayContinue;
      }
      return publishSecond(input);
    };
    const second = publishImagesTransaction({
      ...transactionInput(lockFilePath, secondPublisher, ['staging']),
      lockTiming: {
        now: () => Date.now() + 60_000,
        wait: () => Promise.resolve(),
        timeoutMs: 5_000,
      },
    });
    const secondOutcome = second.then(
      () => 'resolved',
      (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
    );

    try {
      await secondPublishing;
      const successorOwner = await readFile(ownerPath, 'utf8');
      releaseFirstOwnerWrite();
      const firstProgress = await Promise.race([
        firstWaitObserved.then(() => 'waited'),
        firstOutcome,
      ]);

      expect(firstProgress).toBe('waited');
      expect(await readFile(ownerPath, 'utf8')).toBe(successorOwner);
      releaseSecondPublish();
      expect(await secondOutcome).toBe('resolved');
      releaseFirstWait();
      expect(await firstOutcome).toBe('resolved');
    } finally {
      filesystemTestHooks.beforeWriteFile = undefined;
      releaseFirstOwnerWrite();
      releaseSecondPublish();
      releaseFirstWait();
      await Promise.all([firstOutcome, secondOutcome]);
      await rm(lockDirectory, { recursive: true, force: true });
    }
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

  test('recovers a stale dead recovery claim after its claimant crashes', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const lockDirectory = `${lockFilePath}.publish-lock`;
    const recoveryClaimDirectory = `${lockDirectory}.recovery-claim`;
    let now = new Date('2026-08-05T12:00:00.000Z').valueOf();
    const old = new Date(now - 60_000);
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ token: randomUUID(), pid: 2_147_483_647, hostname: hostname() }),
    );
    await utimes(lockDirectory, old, old);
    await mkdir(recoveryClaimDirectory);
    await writeFile(
      join(recoveryClaimDirectory, 'owner.json'),
      JSON.stringify({
        token: randomUUID(),
        pid: 2_147_483_647,
        hostname: hostname(),
        acquiredAtMs: old.valueOf(),
      }),
    );
    await utimes(recoveryClaimDirectory, old, old);

    const recovered = await publishImagesTransaction({
      ...transactionInput(lockFilePath, successfulPublisher([]), ['dev']),
      lockTiming: {
        now: () => now,
        wait(milliseconds: number) {
          now += milliseconds;
          return Promise.resolve();
        },
        timeoutMs: 50,
      },
    });

    expect(recovered.environments.dev?.modalEnvironment).toBe('zapp-dev');
    await expect(access(lockDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(recoveryClaimDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
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

  test('preserves a newly acquired owner while two recoverers contend for an abandoned lock', async () => {
    const lockFilePath = await createLockFixture('{"version":1,"environments":{}}\n');
    const lockDirectory = `${lockFilePath}.publish-lock`;
    const ownerPath = join(lockDirectory, 'owner.json');
    await mkdir(lockDirectory);
    await writeFile(
      ownerPath,
      JSON.stringify({
        token: randomUUID(),
        pid: 2_147_483_647,
        hostname: hostname(),
      }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, old, old);

    let releaseFirstStat: () => void = () => undefined;
    const firstStatMayContinue = new Promise<void>((resolve) => {
      releaseFirstStat = resolve;
    });
    let firstStatReached: () => void = () => undefined;
    const firstStatObserved = new Promise<void>((resolve) => {
      firstStatReached = resolve;
    });
    let secondStatReached: () => void = () => undefined;
    const secondStatObserved = new Promise<void>((resolve) => {
      secondStatReached = resolve;
    });
    let lockStatCalls = 0;
    filesystemTestHooks.afterStat = async (path) => {
      if (path !== lockDirectory) return;
      lockStatCalls += 1;
      if (lockStatCalls === 1) {
        firstStatReached();
        await firstStatMayContinue;
      } else if (lockStatCalls === 2) {
        secondStatReached();
      }
    };

    let releaseFirstWait: () => void = () => undefined;
    const firstWaitMayContinue = new Promise<void>((resolve) => {
      releaseFirstWait = resolve;
    });
    let firstWaitReached: () => void = () => undefined;
    const firstWaitObserved = new Promise<void>((resolve) => {
      firstWaitReached = resolve;
    });
    let firstWaitCalls = 0;
    let firstNow = Date.now();
    const firstCalls: Array<{ operation: string; input: unknown }> = [];
    const firstTransaction = publishImagesTransaction({
      ...transactionInput(lockFilePath, successfulPublisher(firstCalls), ['dev']),
      lockTiming: {
        now: () => firstNow,
        async wait(milliseconds: number) {
          firstWaitCalls += 1;
          if (firstWaitCalls === 1) {
            firstWaitReached();
            await firstWaitMayContinue;
          }
          firstNow += milliseconds;
        },
        timeoutMs: 50,
      },
    });
    const firstOutcome = firstTransaction.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    let releaseSecondWait: () => void = () => undefined;
    const secondWaitMayContinue = new Promise<void>((resolve) => {
      releaseSecondWait = resolve;
    });
    let secondWaitReached: () => void = () => undefined;
    const secondWaitObserved = new Promise<void>((resolve) => {
      secondWaitReached = resolve;
    });
    let secondWaitCalls = 0;
    let secondNow = Date.now();
    let releaseNewOwner: () => void = () => undefined;
    const newOwnerMayFinish = new Promise<void>((resolve) => {
      releaseNewOwner = resolve;
    });
    let newOwnerStarted: () => void = () => undefined;
    const newOwnerIsPublishing = new Promise<void>((resolve) => {
      newOwnerStarted = resolve;
    });
    const secondPublisher = successfulPublisher([]);
    const publishSecond = secondPublisher.publishImage.bind(secondPublisher);
    let secondPublishCalls = 0;
    secondPublisher.publishImage = async (input) => {
      secondPublishCalls += 1;
      if (secondPublishCalls === 1) {
        newOwnerStarted();
        await newOwnerMayFinish;
      }
      return publishSecond(input);
    };

    await firstStatObserved;
    const secondTransaction = publishImagesTransaction({
      ...transactionInput(lockFilePath, secondPublisher, ['staging']),
      lockTiming: {
        now: () => secondNow,
        async wait(milliseconds: number) {
          secondWaitCalls += 1;
          if (secondWaitCalls === 1) {
            secondWaitReached();
            await secondWaitMayContinue;
          }
          secondNow += milliseconds;
        },
        timeoutMs: 50,
      },
    });
    const secondOutcome = secondTransaction.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    try {
      const secondRecoveryPath = await Promise.race([
        secondStatObserved.then(() => 'observed-stale-lock'),
        secondWaitObserved.then(() => 'waited-for-recovery-claim'),
      ]);

      if (secondRecoveryPath === 'observed-stale-lock') {
        releaseSecondWait();
        await newOwnerIsPublishing;
        const newLiveOwner = await readFile(ownerPath, 'utf8');
        releaseFirstStat();
        await firstWaitObserved;
        const canonicalOwner = await readFile(ownerPath, 'utf8').catch(() => {
          throw new Error('new-live-owner displaced from the canonical publication lock');
        });
        expect(canonicalOwner).toBe(newLiveOwner);
      } else {
        releaseFirstStat();
        await firstWaitObserved;
        releaseSecondWait();
        await newOwnerIsPublishing;
        const newLiveOwner = await readFile(ownerPath, 'utf8');
        releaseFirstWait();
        expect(await firstOutcome).toBe('Timed out waiting for Modal image publication lock');
        expect(await readFile(ownerPath, 'utf8')).toBe(newLiveOwner);
      }

      expect(secondRecoveryPath).toBe('waited-for-recovery-claim');
      expect(firstCalls).toHaveLength(0);
      releaseNewOwner();
      expect(await secondOutcome).toBe('resolved');
      await expect(access(lockDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      filesystemTestHooks.afterStat = undefined;
      releaseFirstStat();
      releaseFirstWait();
      releaseSecondWait();
      releaseNewOwner();
      await Promise.all([firstOutcome, secondOutcome]);
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
    const outcome = await transaction.then(
      () => 'resolved',
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error);
      },
    );

    expect(outcome).toBe('Timed out waiting for Modal image publication lock');
    expect(waits).toEqual([25, 25]);
  });
});
