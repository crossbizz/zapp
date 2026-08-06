import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createModalImagePublisher } from '@zapp/sandbox-service/provider/modal';
import {
  ImageDigestSchema,
  ImageSmokeEvidenceSchema,
  ImmutableImageTagSchema,
  ModalAppNameSchema,
  ModalCredentialsSchema,
  ModalEnvironmentSchema,
  PublishedImageNameSchema,
  type ModalCredentials,
  type ModalImagePublisher,
} from '@zapp/sandbox-service/provider-types';
import {
  SourceRevisionSchema,
  createForgeNodeBaseRecipe,
  type SourceRevision,
} from './images/forge-node-base.js';
import { createForgeWebTestRecipe } from './images/forge-web-test.js';

const execFileAsync = promisify(execFile);
const EnvironmentKeySchema = z.enum(['dev', 'staging', 'prod']);
export type EnvironmentKey = z.infer<typeof EnvironmentKeySchema>;

const ALL_ENVIRONMENTS: readonly EnvironmentKey[] = ['dev', 'staging', 'prod'];
const MODAL_ENVIRONMENTS = {
  dev: 'zapp-dev',
  staging: 'zapp-staging',
  prod: 'zapp-prod',
} as const;
const PUBLISH_LOCK_TIMEOUT_MS = 30 * 60_000;
const PUBLISH_LOCK_RETRY_MS = 25;
const ABANDONED_LOCK_GRACE_MS = 30_000;
const PublishLockOwnerSchema = z
  .object({
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
  })
  .strict();

const LockedImageSchema = z
  .object({
    appName: ModalAppNameSchema,
    digest: ImageDigestSchema,
    publishedName: PublishedImageNameSchema,
  })
  .strict();
const LockedBaseImageSchema = LockedImageSchema.extend({
  appName: z.literal('zapp-workspaces'),
});
const LockedWebImageSchema = LockedImageSchema.extend({
  appName: z.literal('zapp-browser-verify'),
});

const LockedEnvironmentSchema = z
  .object({
    modalEnvironment: ModalEnvironmentSchema,
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    tag: ImmutableImageTagSchema,
    images: z
      .object({
        'forge-node-base': LockedBaseImageSchema,
        'forge-web-test': LockedWebImageSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.tag.endsWith(`-${value.sourceRevision.slice(0, 7)}`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tag'],
        message: 'Tag suffix must match source revision',
      });
    }
    for (const [imageName, image] of Object.entries(value.images)) {
      if (image.publishedName !== `${imageName}:${value.tag}`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', imageName, 'publishedName'],
          message: 'Published name must match the environment tag',
        });
      }
    }
  });

export const ImageLockSchema = z
  .object({
    version: z.literal(1),
    environments: z
      .object({
        dev: LockedEnvironmentSchema.optional(),
        staging: LockedEnvironmentSchema.optional(),
        prod: LockedEnvironmentSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const environmentKey of ALL_ENVIRONMENTS) {
      const locked = value.environments[environmentKey];
      if (locked !== undefined && locked.modalEnvironment !== MODAL_ENVIRONMENTS[environmentKey]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['environments', environmentKey, 'modalEnvironment'],
          message: 'Modal environment must match lock key',
        });
      }
    }
  });
export type ImageLock = z.infer<typeof ImageLockSchema>;

export interface PublishTransactionInput {
  readonly environments: readonly EnvironmentKey[];
  readonly sourceRevision: SourceRevision;
  readonly lockFilePath: string;
  readonly provider: ModalImagePublisher;
  readonly buildDate: Date;
  readonly createAgentToken: () => string;
  readonly telemetryEndpoint?: string;
  readonly lockTiming?: PublishLockTiming;
}

export interface PublishLockTiming {
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly timeoutMs: number;
}

interface PreflightInput {
  readonly credentials: {
    readonly tokenId?: string | undefined;
    readonly tokenSecret?: string | undefined;
  };
  readonly sourceRevision: SourceRevision;
  readonly isRevisionAdvertised: (source: SourceRevision) => Promise<boolean>;
}

export function parseModalPublishArgs(argv: readonly string[]): {
  mode: 'publish' | 'smoke';
  environments: EnvironmentKey[];
} {
  const [rawMode, ...argumentsAfterMode] = argv;
  if (rawMode !== 'publish' && rawMode !== 'smoke') {
    throw new Error('Expected publish or smoke command');
  }
  if (argumentsAfterMode.length === 0) {
    return { mode: rawMode, environments: [...ALL_ENVIRONMENTS] };
  }
  if (argumentsAfterMode[0] !== '--env') {
    throw new Error(`Unknown argument: ${argumentsAfterMode[0] ?? ''}`);
  }
  if (argumentsAfterMode.length !== 2) {
    throw new Error('Expected --env followed by dev, staging, or prod');
  }
  const rawEnvironment = argumentsAfterMode[1];
  if (rawEnvironment === 'all') {
    return { mode: rawMode, environments: [...ALL_ENVIRONMENTS] };
  }
  const environment = EnvironmentKeySchema.safeParse(rawEnvironment);
  if (!environment.success) {
    throw new Error('Expected dev, staging, or prod');
  }
  return { mode: rawMode, environments: [environment.data] };
}

export async function collectPublishPreflightBlockers(input: PreflightInput): Promise<string[]> {
  const sourceRevision = SourceRevisionSchema.parse(input.sourceRevision);
  const blockers: string[] = [];
  if (!input.credentials.tokenId || !input.credentials.tokenSecret) {
    blockers.push('Modal credentials are missing: set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET');
  }
  if (!(await input.isRevisionAdvertised(sourceRevision))) {
    blockers.push(
      `Source revision ${sourceRevision.commitSha} is not advertised by ${sourceRevision.repositoryUrl}`,
    );
  }
  return blockers;
}

async function readLock(lockFilePath: string): Promise<ImageLock> {
  try {
    return ImageLockSchema.parse(JSON.parse(await readFile(lockFilePath, 'utf8')) as unknown);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { version: 1, environments: {} };
    }
    throw error;
  }
}

async function writeLockAtomically(lockFilePath: string, lock: ImageLock): Promise<void> {
  const serialized = `${JSON.stringify(ImageLockSchema.parse(lock), null, 2)}\n`;
  const temporaryPath = resolve(
    dirname(lockFilePath),
    `.images.lock.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, lockFilePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isExistingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

async function recoverAbandonedPublishLock(
  lockDirectory: string,
  now: () => number,
): Promise<void> {
  const ownerPath = resolve(lockDirectory, 'owner.json');
  let owner: z.infer<typeof PublishLockOwnerSchema> | undefined;
  try {
    owner = PublishLockOwnerSchema.parse(JSON.parse(await readFile(ownerPath, 'utf8')) as unknown);
  } catch (error) {
    if (!isMissingFile(error)) return;
  }
  if (owner !== undefined && (owner.hostname !== hostname() || processIsAlive(owner.pid))) {
    return;
  }
  const age = now() - (await stat(lockDirectory)).mtimeMs;
  if (age < ABANDONED_LOCK_GRACE_MS) {
    return;
  }
  const quarantine = `${lockDirectory}.abandoned.${randomUUID()}`;
  try {
    await rename(lockDirectory, quarantine);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
}

async function withPublishLock<T>(
  lockFilePath: string,
  action: () => Promise<T>,
  timing: PublishLockTiming = {
    now: Date.now,
    wait: async (milliseconds) =>
      new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    timeoutMs: PUBLISH_LOCK_TIMEOUT_MS,
  },
): Promise<T> {
  const lockDirectory = `${lockFilePath}.publish-lock`;
  const owner = PublishLockOwnerSchema.parse({
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
  });
  const deadline = timing.now() + timing.timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDirectory);
      try {
        await writeFile(resolve(lockDirectory, 'owner.json'), JSON.stringify(owner), {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isExistingFile(error)) throw error;
      await recoverAbandonedPublishLock(lockDirectory, timing.now);
      if (timing.now() >= deadline) {
        throw new Error('Timed out waiting for Modal image publication lock');
      }
      await timing.wait(PUBLISH_LOCK_RETRY_MS);
    }
  }

  try {
    return await action();
  } finally {
    const current = PublishLockOwnerSchema.parse(
      JSON.parse(await readFile(resolve(lockDirectory, 'owner.json'), 'utf8')) as unknown,
    );
    if (current.token !== owner.token) {
      throw new Error('Modal image publication lock ownership changed');
    }
    await rm(lockDirectory, { recursive: true });
  }
}

function immutableTag(buildDate: Date, sourceRevision: SourceRevision): string {
  if (Number.isNaN(buildDate.valueOf())) {
    throw new Error('Invalid build date');
  }
  return ImmutableImageTagSchema.parse(
    `${buildDate.toISOString().slice(0, 10)}-${sourceRevision.commitSha.slice(0, 7)}`,
  );
}

export async function publishImagesTransaction(
  untrustedInput: PublishTransactionInput,
): Promise<ImageLock> {
  const environments = z
    .array(EnvironmentKeySchema)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length, 'Duplicate environments')
    .parse(untrustedInput.environments);
  const sourceRevision = SourceRevisionSchema.parse(untrustedInput.sourceRevision);
  const tag = immutableTag(untrustedInput.buildDate, sourceRevision);
  return withPublishLock(untrustedInput.lockFilePath, async () => {
    const current = await readLock(untrustedInput.lockFilePath);
    const next = structuredClone(current);

    for (const environmentKey of environments) {
      const environment = MODAL_ENVIRONMENTS[environmentKey];
      const basePublishedName = `forge-node-base:${tag}`;
      const webPublishedName = `forge-web-test:${tag}`;
      const base = await untrustedInput.provider.publishImage({
        environment,
        appName: 'zapp-workspaces',
        imageName: 'forge-node-base',
        tag,
        publishedName: basePublishedName,
        recipe: createForgeNodeBaseRecipe(sourceRevision),
      });
      const web = await untrustedInput.provider.publishImage({
        environment,
        appName: 'zapp-browser-verify',
        imageName: 'forge-web-test',
        tag,
        publishedName: webPublishedName,
        recipe: createForgeWebTestRecipe(base.digest),
      });
      ImageSmokeEvidenceSchema.parse(
        await untrustedInput.provider.smokeImage({
          environment,
          appName: 'zapp-workspaces',
          digest: base.digest,
          publishedName: base.publishedName,
          agentToken: untrustedInput.createAgentToken(),
          ...(untrustedInput.telemetryEndpoint === undefined
            ? {}
            : { telemetryEndpoint: untrustedInput.telemetryEndpoint }),
        }),
      );

      next.environments[environmentKey] = LockedEnvironmentSchema.parse({
        modalEnvironment: environment,
        sourceRevision: sourceRevision.commitSha,
        tag,
        images: {
          'forge-node-base': {
            appName: 'zapp-workspaces',
            digest: base.digest,
            publishedName: base.publishedName,
          },
          'forge-web-test': {
            appName: 'zapp-browser-verify',
            digest: web.digest,
            publishedName: web.publishedName,
          },
        },
      });
    }

    for (const environmentKey of environments) {
      const locked = next.environments[environmentKey];
      if (locked === undefined) {
        throw new Error(`No newly published images are available for ${environmentKey}`);
      }
      await untrustedInput.provider.verifyPublishedImage({
        environment: locked.modalEnvironment,
        digest: locked.images['forge-node-base'].digest,
        publishedName: locked.images['forge-node-base'].publishedName,
      });
      await untrustedInput.provider.verifyPublishedImage({
        environment: locked.modalEnvironment,
        digest: locked.images['forge-web-test'].digest,
        publishedName: locked.images['forge-web-test'].publishedName,
      });
    }

    const validated = ImageLockSchema.parse(next);
    await writeLockAtomically(untrustedInput.lockFilePath, validated);
    return validated;
  }, untrustedInput.lockTiming);
}

async function smokeLockedImages(
  lock: ImageLock,
  environments: readonly EnvironmentKey[],
  provider: ModalImagePublisher,
  telemetryEndpoint?: string,
): Promise<void> {
  for (const environmentKey of environments) {
    const locked = lock.environments[environmentKey];
    if (locked === undefined) {
      throw new Error(`No published images are locked for ${environmentKey}`);
    }
    const base = locked.images['forge-node-base'];
    await provider.smokeImage({
      environment: locked.modalEnvironment,
      appName: 'zapp-workspaces',
      digest: base.digest,
      publishedName: base.publishedName,
      agentToken: randomUUID(),
      ...(telemetryEndpoint === undefined ? {} : { telemetryEndpoint }),
    });
  }
}

async function resolveSourceRevision(repositoryRoot: string): Promise<SourceRevision> {
  const [{ stdout: commitSha }, { stdout: repositoryUrl }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    execFileAsync('git', ['remote', 'get-url', 'upstream'], { cwd: repositoryRoot }),
  ]);
  return SourceRevisionSchema.parse({
    repositoryUrl: repositoryUrl.trim(),
    commitSha: commitSha.trim(),
  });
}

async function isRevisionAdvertised(sourceRevision: SourceRevision): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['ls-remote', sourceRevision.repositoryUrl]);
  return stdout.split('\n').some((line) => line.split(/\s+/u, 1)[0] === sourceRevision.commitSha);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = parseModalPublishArgs(argv);
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const lockFilePath = fileURLToPath(new URL('./images.lock.json', import.meta.url));
  const sourceRevision = await resolveSourceRevision(repositoryRoot);
  const rawCredentials = {
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
  };
  const blockers = await collectPublishPreflightBlockers({
    credentials: rawCredentials,
    sourceRevision,
    isRevisionAdvertised,
  });
  if (blockers.length > 0) {
    throw new Error(`Modal publication blocked:\n- ${blockers.join('\n- ')}`);
  }

  const credentials: ModalCredentials = ModalCredentialsSchema.parse(rawCredentials);
  const provider = createModalImagePublisher({ credentials });
  const telemetryEndpoint = process.env.ZAPP_SANDBOX_TELEMETRY_ENDPOINT;
  if (command.mode === 'publish') {
    const lock = await publishImagesTransaction({
      environments: command.environments,
      sourceRevision,
      lockFilePath,
      provider,
      buildDate: new Date(),
      createAgentToken: randomUUID,
      ...(telemetryEndpoint === undefined ? {} : { telemetryEndpoint }),
    });
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
    return;
  }

  await smokeLockedImages(
    await readLock(lockFilePath),
    command.environments,
    provider,
    telemetryEndpoint,
  );
  process.stdout.write(`Modal VM smoke passed for ${command.environments.join(', ')}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Modal publication failed'}\n`,
    );
    process.exitCode = 1;
  });
}
