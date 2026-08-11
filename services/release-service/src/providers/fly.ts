import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import {
  CommitShaSchema,
  CompatibilityResultSchema,
  DeploymentArtifactSchema,
  EnvironmentIdSchema,
  ExecutionContractSchema,
  idSchema,
  type CompatibilityResult,
  type DeploymentArtifact,
  type ExecutionContract,
  type ProjectContext,
} from '@zapp/contracts';
import { z } from 'zod';

const FlyAppNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u);
const PackageJsonSchema = z.object({
  scripts: z.record(z.string().trim().min(1)).optional(),
});

export const FlyImageBuildInputSchema = z
  .object({
    projectId: idSchema('proj'),
    environmentId: EnvironmentIdSchema,
    commitSha: CommitShaSchema,
    contract: ExecutionContractSchema,
  })
  .strict();
export type FlyImageBuildInput = z.infer<typeof FlyImageBuildInputSchema>;

const FlyBuildExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export interface FlyBuildSandboxPort {
  fileExists(path: string): Promise<boolean>;
  writeFile(path: string, contents: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exec(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<z.infer<typeof FlyBuildExecResultSchema>>;
}

export class FlyProviderError extends Error {
  constructor(readonly code: 'fly_image_build_failed', message: string) {
    super(message);
    this.name = 'FlyProviderError';
  }
}

function providerSegment(value: string, prefix: 'proj' | 'env'): string {
  const withoutPrefix = value.replace(new RegExp(`^${prefix}[_-]`, 'u'), '');
  const normalized = withoutPrefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized === '' ? prefix : normalized;
}

/** One stable Fly app owns one zapp project-environment pair. */
export function flyAppName(projectIdValue: unknown, environmentIdValue: unknown): string {
  const { projectId, environmentId } = z
    .object({
      projectId: idSchema('proj'),
      environmentId: EnvironmentIdSchema,
    })
    .strict()
    .parse({ projectId: projectIdValue, environmentId: environmentIdValue });
  const raw = `zapp-${providerSegment(projectId, 'proj')}-${providerSegment(environmentId, 'env')}`;
  if (raw.length <= 63) return FlyAppNameSchema.parse(raw);

  const suffix = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const prefix = raw.slice(0, 50).replace(/-+$/u, '');
  return FlyAppNameSchema.parse(`${prefix}-${suffix}`);
}

export async function detectFlyCompatibility(ctx: ProjectContext): Promise<CompatibilityResult> {
  const dockerfiles = await ctx.listFiles('Dockerfile');
  if (dockerfiles.length > 0) {
    return CompatibilityResultSchema.parse({
      providerId: 'fly',
      compatible: true,
      reasons: ['Dockerfile is present.'],
    });
  }

  try {
    const packageJson = PackageJsonSchema.parse(JSON.parse(await ctx.readFile('package.json')));
    if (packageJson.scripts?.['build'] !== undefined && packageJson.scripts['start'] !== undefined) {
      return CompatibilityResultSchema.parse({
        providerId: 'fly',
        compatible: true,
        reasons: ['Node build and start scripts are present.'],
      });
    }
  } catch {
    // An absent or malformed package manifest is simply not compatible with this provider.
  }

  return CompatibilityResultSchema.parse({
    providerId: 'fly',
    compatible: false,
    reasons: ['Fly requires a Dockerfile or Node build and start scripts.'],
  });
}

function requireDeployCommands(contractValue: unknown): ExecutionContract & {
  readonly build: NonNullable<ExecutionContract['build']>;
  readonly start: NonNullable<ExecutionContract['start']>;
} {
  const contract = ExecutionContractSchema.parse(contractValue);
  if (contract.build === undefined || contract.start === undefined) {
    throw new Error('Fly image builds require production build and start commands.');
  }
  return { ...contract, build: contract.build, start: contract.start };
}

function shellInstruction(command: string): string {
  return JSON.stringify(['sh', '-lc', command]);
}

export function renderFlyDockerfile(contractValue: unknown): string {
  const contract = requireDeployCommands(contractValue);
  return [
    'FROM node:22-slim AS build',
    'WORKDIR /app',
    'RUN corepack enable',
    'COPY . .',
    `RUN ${shellInstruction(contract.install.command)}`,
    `RUN ${shellInstruction(contract.build.command)}`,
    '',
    'FROM node:22-slim AS runtime',
    'ENV NODE_ENV=production',
    'WORKDIR /app',
    'RUN groupadd --system zapp && useradd --system --gid zapp --home /app zapp',
    'COPY --from=build --chown=zapp:zapp /app /app',
    'USER zapp',
    `CMD ${shellInstruction(contract.start.command)}`,
    '',
  ].join('\n');
}

function buildTimeoutMs(contract: ExecutionContract): number {
  const installSeconds = contract.install.timeout_seconds ?? 300;
  const buildSeconds = contract.build?.timeout_seconds ?? 600;
  const registryPushSeconds = 300;
  return (installSeconds + buildSeconds + registryPushSeconds) * 1_000;
}

/**
 * Builds inside the already-contained, registry-authenticated sandbox. No provider
 * credential or application secret is accepted by this boundary or passed to buildx.
 */
export async function buildFlyImage(
  inputValue: unknown,
  deps: { readonly sandbox: FlyBuildSandboxPort },
): Promise<DeploymentArtifact> {
  const input = FlyImageBuildInputSchema.parse(inputValue);
  const contract = ExecutionContractSchema.parse(input.contract);
  const appName = flyAppName(input.projectId, input.environmentId);
  const reference = `registry.fly.io/${appName}:${input.commitSha}`;
  const workspaceRoot = contract.workspace_root;
  const projectDockerfilePath = posix.join(workspaceRoot, 'Dockerfile');
  const generatedDockerfilePath = posix.join(workspaceRoot, '.zapp/Dockerfile.fly');
  const hasProjectDockerfile = await deps.sandbox.fileExists(projectDockerfilePath);
  const dockerfileArgument = hasProjectDockerfile ? 'Dockerfile' : '.zapp/Dockerfile.fly';

  if (!hasProjectDockerfile) {
    await deps.sandbox.writeFile(generatedDockerfilePath, renderFlyDockerfile(contract));
  }

  try {
    const result = FlyBuildExecResultSchema.parse(
      await deps.sandbox.exec({
        command: 'docker',
        args: [
          'buildx',
          'build',
          '--file',
          dockerfileArgument,
          '--tag',
          reference,
          '--push',
          '.',
        ],
        cwd: workspaceRoot,
        timeoutMs: buildTimeoutMs(contract),
      }),
    );
    if (result.exitCode !== 0) {
      throw new FlyProviderError(
        'fly_image_build_failed',
        'The sandbox could not build and push the Fly image.',
      );
    }
    return DeploymentArtifactSchema.parse({ kind: 'container_image', reference });
  } finally {
    if (!hasProjectDockerfile) await deps.sandbox.deleteFile(generatedDockerfilePath);
  }
}
