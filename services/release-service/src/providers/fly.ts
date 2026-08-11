import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import {
  CommitShaSchema,
  CompatibilityResultSchema,
  DeploymentArtifactSchema,
  DeploymentHandleSchema,
  EnvironmentIdSchema,
  ExecutionContractSchema,
  ProductionDeploymentInputSchema,
  RollbackInputSchema,
  idSchema,
  type CompatibilityResult,
  type DeploymentArtifact,
  type DeploymentHandle,
  type DeploymentProvider,
  type ExecutionContract,
  type ProductionDeploymentInput,
  type ProjectContext,
  type RollbackInput,
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
const EnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const SecretReferenceMapSchema = z.record(EnvironmentNameSchema, idSchema('sec'));
const ResolvedEnvironmentSchema = z.record(EnvironmentNameSchema, z.string());
const FlyMachineIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const FlyProviderDeploymentIdSchema = z
  .string()
  .regex(/^fly:[a-z0-9](?:[a-z0-9-]*[a-z0-9]):[A-Za-z0-9_-]+$/u);

const FlyMachineConfigSchema = z
  .object({
    image: z.string().min(1),
    init: z
      .object({ cmd: z.array(z.string()).min(1) })
      .passthrough()
      .optional(),
    metadata: z.record(z.string()).optional(),
    restart: z
      .object({
        policy: z.string().min(1),
        max_retries: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    services: z
      .array(
        z
          .object({ internal_port: z.number().int().min(1).max(65_535) })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
type FlyMachineConfig = z.infer<typeof FlyMachineConfigSchema>;

const FlyMachineSchema = z
  .object({
    id: FlyMachineIdSchema,
    state: z.string().min(1),
    config: FlyMachineConfigSchema,
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1),
            status: z.string().min(1),
          })
          .passthrough(),
      )
      .optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();
type FlyMachine = z.infer<typeof FlyMachineSchema>;

const FlyUsageEntrySchema = z
  .object({
    category: z.literal('deploy_provider'),
    provider: z.literal('fly'),
    projectId: idSchema('proj'),
    environmentId: EnvironmentIdSchema,
    releaseId: idSchema('rel').nullable(),
    providerDeploymentId: FlyProviderDeploymentIdSchema,
    quantity: z.literal('1'),
    unit: z.literal('deployment'),
  })
  .strict();
export type FlyUsageEntry = z.infer<typeof FlyUsageEntrySchema>;

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

/** Release-service's allowlisted, audited vault boundary. Input values are references, never plaintext. */
export interface FlyVaultPort {
  resolveEnvironment(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly references: Readonly<Record<string, string>>;
    readonly reason: string;
  }): Promise<unknown>;
}

/** Loads the immutable contract recorded for the exact commit being deployed. */
export interface FlyContractPort {
  resolve(input: {
    readonly projectId: string;
    readonly commitSha: string;
  }): Promise<unknown>;
}

/** OPS-2 seam. The control plane owns ledger pricing, idempotency, and tenant attribution. */
export interface FlyUsagePort {
  record(input: FlyUsageEntry): Promise<void>;
}

export interface FlyDeploymentProviderDependencies {
  readonly apiBaseUrl?: string;
  readonly apiToken: string;
  readonly organizationSlug: string;
  readonly vault: FlyVaultPort;
  readonly contracts: FlyContractPort;
  readonly usage: FlyUsagePort;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly healthPollAttempts?: number;
  readonly healthPollIntervalMs?: number;
}

export class FlyProviderError extends Error {
  constructor(
    readonly code:
      | 'fly_image_build_failed'
      | 'fly_api_error'
      | 'fly_health_check_failed'
      | 'fly_cross_app_rollback'
      | 'fly_invalid_deployment_id'
      | 'fly_invalid_artifact'
      | 'fly_invalid_contract'
      | 'fly_invalid_vault_response',
    message: string,
  ) {
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

export function encodeFlyProviderDeploymentId(appNameValue: unknown, machineIdValue: unknown): string {
  const appName = FlyAppNameSchema.parse(appNameValue);
  const machineId = FlyMachineIdSchema.parse(machineIdValue);
  return FlyProviderDeploymentIdSchema.parse(`fly:${appName}:${machineId}`);
}

function decodeFlyProviderDeploymentId(value: unknown): {
  readonly appName: string;
  readonly machineId: string;
} {
  const parsed = FlyProviderDeploymentIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new FlyProviderError(
      'fly_invalid_deployment_id',
      'The Fly deployment identifier is invalid.',
    );
  }
  const [, appName, machineId] = parsed.data.split(':');
  return {
    appName: FlyAppNameSchema.parse(appName),
    machineId: FlyMachineIdSchema.parse(machineId),
  };
}

class FlyMachinesApiClient {
  private readonly baseUrl: string;

  constructor(
    apiBaseUrl: string,
    private readonly apiToken: string,
    private readonly doFetch: typeof fetch,
  ) {
    this.baseUrl = z.string().url().parse(apiBaseUrl).replace(/\/$/u, '');
    z.string().min(1).parse(apiToken);
  }

  async appExists(appName: string): Promise<boolean> {
    const response = await this.request(`/apps/${encodeURIComponent(appName)}`, { method: 'GET' }, [
      200,
      404,
    ]);
    if (response.status === 404) return false;
    const body = await this.json(response);
    const app = z.object({ name: FlyAppNameSchema }).passthrough().parse(body);
    if (app.name !== appName) {
      throw new FlyProviderError('fly_api_error', 'Fly returned the wrong application.');
    }
    return true;
  }

  async createApp(appName: string, organizationSlug: string): Promise<void> {
    await this.requestJson(
      '/apps',
      { method: 'POST', body: { app_name: appName, org_slug: organizationSlug } },
      z.object({ name: FlyAppNameSchema }).passthrough(),
      [200, 201],
    );
  }

  async setSecret(appName: string, name: string, value: string): Promise<void> {
    await this.request(
      `/apps/${encodeURIComponent(appName)}/secrets/${encodeURIComponent(name)}`,
      { method: 'POST', body: { value } },
      [200, 201, 204],
    );
  }

  async listMachines(appName: string): Promise<readonly FlyMachine[]> {
    return this.requestJson(
      `/apps/${encodeURIComponent(appName)}/machines`,
      { method: 'GET' },
      z.array(FlyMachineSchema),
      [200],
    );
  }

  async getMachine(appName: string, machineId: string): Promise<FlyMachine> {
    return this.requestJson(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      { method: 'GET' },
      FlyMachineSchema,
      [200],
    );
  }

  async createMachine(appName: string, configValue: unknown): Promise<FlyMachine> {
    const config = FlyMachineConfigSchema.parse(configValue);
    return this.requestJson(
      `/apps/${encodeURIComponent(appName)}/machines?skip_service_registration=true`,
      { method: 'POST', body: { config } },
      FlyMachineSchema,
      [200, 201],
    );
  }

  async uncordonMachine(appName: string, machineId: string): Promise<void> {
    await this.request(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/uncordon`,
      { method: 'POST' },
      [200, 201, 204],
    );
  }

  async stopMachine(appName: string, machineId: string): Promise<void> {
    await this.request(
      `/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`,
      { method: 'POST' },
      [200, 201, 204],
    );
  }

  private async requestJson<T>(
    path: string,
    input: { readonly method: string; readonly body?: unknown },
    schema: z.ZodType<T>,
    expectedStatuses: readonly number[],
  ): Promise<T> {
    const response = await this.request(path, input, expectedStatuses);
    return schema.parse(await this.json(response));
  }

  private async request(
    path: string,
    input: { readonly method: string; readonly body?: unknown },
    expectedStatuses: readonly number[],
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method: input.method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiToken}`,
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FlyProviderError('fly_api_error', 'The Fly Machines API could not be reached.');
    }
    if (!expectedStatuses.includes(response.status)) {
      throw new FlyProviderError(
        'fly_api_error',
        `The Fly Machines API rejected an operation (${String(response.status)}).`,
      );
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new FlyProviderError('fly_api_error', 'The Fly Machines API returned invalid JSON.');
    }
  }
}

function productionMachineConfig(
  input: ProductionDeploymentInput,
  contract: ExecutionContract,
): FlyMachineConfig {
  if (contract.start === undefined || contract.health === undefined) {
    throw new FlyProviderError(
      'fly_invalid_contract',
      'Fly production deploys require start and health commands in the execution contract.',
    );
  }
  return FlyMachineConfigSchema.parse({
    image: input.artifact.reference,
    init: { cmd: ['sh', '-lc', contract.start.command] },
    metadata: {
      zapp_release_id: input.releaseId,
      zapp_project_id: input.projectId,
      zapp_environment_id: input.environmentId,
      zapp_commit_sha: input.commitSha,
    },
    restart: { policy: 'on-failure', max_retries: 3 },
    services: [
      {
        protocol: 'tcp',
        internal_port: contract.develop.port,
        ports: [
          { port: 80, handlers: ['http'] },
          { port: 443, handlers: ['tls', 'http'] },
        ],
        http_checks: [
          {
            path: contract.health.path,
            method: 'GET',
            protocol: 'http',
            interval: '10s',
            timeout: '2s',
            grace_period: '5s',
          },
        ],
      },
    ],
  });
}

function validateProductionInput(inputValue: unknown): ProductionDeploymentInput {
  const input = ProductionDeploymentInputSchema.parse(inputValue);
  const appName = flyAppName(input.projectId, input.environmentId);
  const expectedReference = `registry.fly.io/${appName}:${input.commitSha}`;
  if (input.artifact.kind !== 'container_image' || input.artifact.reference !== expectedReference) {
    throw new FlyProviderError(
      'fly_invalid_artifact',
      'Fly requires the exact-commit container image built for this project environment.',
    );
  }
  SecretReferenceMapSchema.parse(input.env);
  return input;
}

function requireMatchingVaultValues(
  referencesValue: unknown,
  valuesValue: unknown,
): Readonly<Record<string, string>> {
  const references = SecretReferenceMapSchema.parse(referencesValue);
  const parsed = ResolvedEnvironmentSchema.safeParse(valuesValue);
  if (!parsed.success) {
    throw new FlyProviderError(
      'fly_invalid_vault_response',
      'The release vault returned an invalid environment.',
    );
  }
  const expectedNames = Object.keys(references).sort();
  const actualNames = Object.keys(parsed.data).sort();
  if (expectedNames.join('\0') !== actualNames.join('\0')) {
    throw new FlyProviderError(
      'fly_invalid_vault_response',
      'The release vault returned the wrong environment names.',
    );
  }
  return parsed.data;
}

function isHealthy(machine: FlyMachine): boolean {
  return (
    machine.state === 'started' &&
    machine.checks !== undefined &&
    machine.checks.length > 0 &&
    machine.checks.every(({ status }) => status === 'passing')
  );
}

type FlyProductionProvider = Pick<
  DeploymentProvider,
  'detectCompatibility' | 'deployProduction' | 'rollback'
>;

export function createFlyDeploymentProvider(
  dependencies: FlyDeploymentProviderDependencies,
): FlyProductionProvider {
  const apiBaseUrl = dependencies.apiBaseUrl ?? 'https://api.machines.dev/v1';
  const organizationSlug = z.string().trim().min(1).max(256).parse(dependencies.organizationSlug);
  const client = new FlyMachinesApiClient(
    apiBaseUrl,
    dependencies.apiToken,
    dependencies.fetch ?? fetch,
  );
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const healthPollAttempts = z.number().int().min(1).max(120).parse(dependencies.healthPollAttempts ?? 30);
  const healthPollIntervalMs = z.number().int().nonnegative().max(60_000).parse(
    dependencies.healthPollIntervalMs ?? 2_000,
  );

  const recordUsage = async (input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly releaseId: string | null;
    readonly providerDeploymentId: string;
  }): Promise<void> => {
    await dependencies.usage.record(
      FlyUsageEntrySchema.parse({
        category: 'deploy_provider',
        provider: 'fly',
        ...input,
        quantity: '1',
        unit: 'deployment',
      }),
    );
  };

  const handoff = async (input: {
    readonly appName: string;
    readonly config: FlyMachineConfig;
    readonly previousMachines: readonly FlyMachine[];
    readonly projectId: string;
    readonly environmentId: string;
    readonly releaseId: string | null;
  }): Promise<DeploymentHandle> => {
    const candidate = await client.createMachine(input.appName, input.config);
    const providerDeploymentId = encodeFlyProviderDeploymentId(input.appName, candidate.id);
    try {
      await recordUsage({
        projectId: input.projectId,
        environmentId: input.environmentId,
        releaseId: input.releaseId,
        providerDeploymentId,
      });
      let healthy = false;
      for (let attempt = 0; attempt < healthPollAttempts; attempt += 1) {
        const observed = await client.getMachine(input.appName, candidate.id);
        if (isHealthy(observed)) {
          healthy = true;
          break;
        }
        if (attempt + 1 < healthPollAttempts) await sleep(healthPollIntervalMs);
      }
      if (!healthy) {
        throw new FlyProviderError(
          'fly_health_check_failed',
          'The candidate Fly Machine did not pass its service health check.',
        );
      }
      await client.uncordonMachine(input.appName, candidate.id);
      for (const previous of input.previousMachines) {
        if (previous.id !== candidate.id && previous.state === 'started') {
          await client.stopMachine(input.appName, previous.id);
        }
      }
      return DeploymentHandleSchema.parse({
        providerId: 'fly',
        providerDeploymentId,
        url: new URL(`https://${input.appName}.fly.dev`).toString(),
        state: 'ready',
        createdAt: now().toISOString(),
      });
    } catch (error) {
      await client.stopMachine(input.appName, candidate.id).catch(() => undefined);
      throw error;
    }
  };

  return {
    detectCompatibility: detectFlyCompatibility,

    async deployProduction(inputValue: ProductionDeploymentInput): Promise<DeploymentHandle> {
      const input = validateProductionInput(inputValue);
      const appName = flyAppName(input.projectId, input.environmentId);
      const references = SecretReferenceMapSchema.parse(input.env);
      const resolved = requireMatchingVaultValues(
        references,
        await dependencies.vault.resolveEnvironment({
          projectId: input.projectId,
          environmentId: input.environmentId,
          references,
          reason: `deploy release ${input.releaseId} to Fly`,
        }),
      );
      const contract = ExecutionContractSchema.parse(
        await dependencies.contracts.resolve({
          projectId: input.projectId,
          commitSha: input.commitSha,
        }),
      );
      const config = productionMachineConfig(input, contract);
      if (!(await client.appExists(appName))) {
        await client.createApp(appName, organizationSlug);
      }
      for (const name of Object.keys(resolved).sort()) {
        await client.setSecret(appName, name, resolved[name] ?? '');
      }
      const previousMachines = await client.listMachines(appName);
      return handoff({
        appName,
        config,
        previousMachines,
        projectId: input.projectId,
        environmentId: input.environmentId,
        releaseId: input.releaseId,
      });
    },

    async rollback(inputValue: RollbackInput): Promise<DeploymentHandle> {
      const input = RollbackInputSchema.parse(inputValue);
      const appName = flyAppName(input.projectId, input.environmentId);
      const target = decodeFlyProviderDeploymentId(input.toProviderDeploymentId);
      if (target.appName !== appName) {
        throw new FlyProviderError(
          'fly_cross_app_rollback',
          'The rollback target belongs to a different Fly application.',
        );
      }
      const retained = await client.getMachine(appName, target.machineId);
      const previousMachines = await client.listMachines(appName);
      return handoff({
        appName,
        config: retained.config,
        previousMachines,
        projectId: input.projectId,
        environmentId: input.environmentId,
        releaseId: null,
      });
    },
  };
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
