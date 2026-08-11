import { createHash } from 'node:crypto';

import {
  AppTypeSchema,
  CommitShaSchema,
  ModelIdentifierSchema,
  RunModeSchema,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import { OperationKeySchema } from '../orchestrator/port.js';

const BranchNameSchema = z.string().trim().min(1).max(255);
const ProjectNameSchema = z.string().trim().min(1).max(80);
const CheckpointRefSchema = z.string().trim().min(1).max(4_096);
const DeploymentConfigurationSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    environmentNames: z.array(z.string().trim().min(1).max(100)).max(100),
  })
  .strict();

const ForkCommonSchema = z
  .object({
    sourceOrganizationId: idSchema('org'),
    destinationOrganizationId: idSchema('org'),
    actorId: idSchema('user'),
    operationKey: OperationKeySchema,
  })
  .strict();

export const ProjectForkInputSchema = ForkCommonSchema.extend({
  target: z.literal('project'),
  sourceProjectId: idSchema('proj'),
  name: ProjectNameSchema,
  copyDeploymentConfig: z.boolean().default(false),
}).strict();

export const BranchForkInputSchema = ForkCommonSchema.extend({
  target: z.literal('branch'),
  projectId: idSchema('proj'),
  name: BranchNameSchema,
  fromSha: CommitShaSchema,
}).strict();

const RunForkCommonShape = {
  sourceRunId: idSchema('run'),
  destinationProjectId: idSchema('proj'),
  destinationBranchId: idSchema('br').nullable().default(null),
} as const;

export const ConversationForkInputSchema = ForkCommonSchema.extend({
  target: z.literal('conversation'),
  ...RunForkCommonShape,
}).strict();

export const CheckpointForkInputSchema = ForkCommonSchema.extend({
  target: z.literal('run_checkpoint'),
  ...RunForkCommonShape,
  checkpointRef: CheckpointRefSchema,
}).strict();

export const ReleaseRepairForkInputSchema = ForkCommonSchema.extend({
  target: z.literal('release_repair'),
  releaseId: idSchema('rel'),
  startFixRun: z.boolean().default(false),
}).strict();

export const ForkActivityInputSchema = z.discriminatedUnion('target', [
  ProjectForkInputSchema,
  BranchForkInputSchema,
  ConversationForkInputSchema,
  CheckpointForkInputSchema,
  ReleaseRepairForkInputSchema,
]);
export type ForkActivityInput = z.infer<typeof ForkActivityInputSchema>;

export const ProjectForkResultSchema = z
  .object({
    target: z.literal('project'),
    sourceProjectId: idSchema('proj'),
    projectId: idSchema('proj'),
    branchId: idSchema('br'),
    secretSetupChecklist: z.array(z.string().trim().min(1).max(255)).max(1_000),
    deploymentConfigCopied: z.boolean(),
  })
  .strict();
export const BranchForkResultSchema = z
  .object({
    target: z.literal('branch'),
    projectId: idSchema('proj'),
    branchId: idSchema('br'),
    headCommitSha: CommitShaSchema,
  })
  .strict();
export const ConversationForkResultSchema = z
  .object({
    target: z.literal('conversation'),
    sourceRunId: idSchema('run'),
    runId: idSchema('run'),
    contextArtifactId: idSchema('art'),
  })
  .strict();
export const CheckpointForkResultSchema = z
  .object({
    target: z.literal('run_checkpoint'),
    sourceRunId: idSchema('run'),
    runId: idSchema('run'),
    workspaceId: idSchema('ws'),
    contextArtifactId: idSchema('art'),
    checkpointRef: CheckpointRefSchema,
  })
  .strict();
export const ReleaseRepairForkResultSchema = z
  .object({
    target: z.literal('release_repair'),
    releaseId: idSchema('rel'),
    branchId: idSchema('br'),
    fixRunId: idSchema('run').nullable(),
  })
  .strict();

export const ForkActivityResultSchema = z.discriminatedUnion('target', [
  ProjectForkResultSchema,
  BranchForkResultSchema,
  ConversationForkResultSchema,
  CheckpointForkResultSchema,
  ReleaseRepairForkResultSchema,
]);
export type ForkActivityResult = z.infer<typeof ForkActivityResultSchema>;

export const ProjectForkSourceSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    repositoryRef: z.string().trim().min(1).max(1_024),
    defaultBranch: BranchNameSchema,
    defaultBranchHeadSha: CommitShaSchema.nullable(),
    name: ProjectNameSchema,
    description: z.string().max(2_000).nullable(),
    supportLevel: z.string().trim().min(1).max(100),
    secretNames: z.array(z.string().trim().min(1).max(255)).max(1_000),
    deploymentConfiguration: DeploymentConfigurationSchema.nullable(),
    artifactIds: z.array(idSchema('art')).max(10_000),
  })
  .strict();
export type ProjectForkSource = z.infer<typeof ProjectForkSourceSchema>;
export type ProjectForkEntitySource = Omit<ProjectForkSource, 'deploymentConfiguration'>;

export const RunForkSourceSchema = z
  .object({
    organizationId: idSchema('org'),
    runId: idSchema('run'),
    projectId: idSchema('proj'),
    branchId: idSchema('br').nullable(),
    mode: RunModeSchema,
    appType: AppTypeSchema,
    model: ModelIdentifierSchema.nullable(),
    checkpointRefs: z.array(CheckpointRefSchema).max(10_000),
    artifactIds: z.array(idSchema('art')).max(10_000),
  })
  .strict();
export type RunForkSource = z.infer<typeof RunForkSourceSchema>;

export interface ForkSourcePort {
  project(input: {
    readonly sourceOrganizationId: string;
    readonly sourceProjectId: string;
  }): Promise<unknown>;
  run(input: {
    readonly sourceOrganizationId: string;
    readonly sourceRunId: string;
  }): Promise<unknown>;
}

export interface CreateProjectForkEntityInput {
  readonly projectId: string;
  readonly branchId: string;
  readonly destinationOrganizationId: string;
  readonly actorId: string;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly source: ProjectForkEntitySource;
  readonly copyRepository: () => Promise<void>;
}

export interface CreateBranchForkEntityInput {
  readonly branchId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly name: string;
  readonly fromSha: string;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly createBranchRef: () => Promise<void>;
}

export interface CreateRunForkEntityInput {
  readonly runId: string;
  readonly destinationOrganizationId: string;
  readonly destinationProjectId: string;
  readonly destinationBranchId: string | null;
  readonly actorId: string;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly source: RunForkSource;
  readonly contextArtifactId: string;
  readonly kind: 'conversation' | 'run_checkpoint';
}

export interface ForkEntityPort {
  createProject(
    input: CreateProjectForkEntityInput,
  ): Promise<{ readonly projectId: string; readonly branchId: string }>;
  createBranch(input: CreateBranchForkEntityInput): Promise<{ readonly branchId: string }>;
  createRun(input: CreateRunForkEntityInput): Promise<{ readonly runId: string }>;
}

export interface ForkGitPort {
  copyRepository(input: {
    readonly sourceOrganizationId: string;
    readonly sourceProjectId: string;
    readonly destinationOrganizationId: string;
    readonly destinationProjectId: string;
    readonly defaultBranch: string;
    readonly operationKey: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  createBranchRef(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly name: string;
    readonly fromSha: string;
    readonly operationKey: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export interface ForkContextPort {
  compactAndLink(input: {
    readonly sourceOrganizationId: string;
    readonly sourceRunId: string;
    readonly destinationOrganizationId: string;
    readonly destinationProjectId: string;
    readonly destinationRunId: string;
    readonly destinationArtifactId: string;
    readonly operationKey: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly artifactId: string; readonly sourceRunId: string }>;
  restoreCheckpoint(input: {
    readonly sourceOrganizationId: string;
    readonly sourceRunId: string;
    readonly destinationOrganizationId: string;
    readonly destinationProjectId: string;
    readonly destinationBranchId: string | null;
    readonly destinationRunId: string;
    readonly workspaceId: string;
    readonly checkpointRef: string;
    readonly operationKey: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly workspaceId: string; readonly checkpointRef: string }>;
}

export interface ForkDeploymentPort {
  copyConfiguration(input: {
    readonly sourceOrganizationId: string;
    readonly sourceProjectId: string;
    readonly destinationOrganizationId: string;
    readonly destinationProjectId: string;
    readonly configuration: z.infer<typeof DeploymentConfigurationSchema>;
    readonly operationKey: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export interface ForkReleasePort {
  forkRelease(input: {
    readonly sourceOrganizationId: string;
    readonly destinationOrganizationId: string;
    readonly releaseId: string;
    readonly branchId: string;
    readonly branchName: string;
    readonly fixRunId: string;
    readonly startFixRun: boolean;
    readonly actorId: string;
    readonly operationKey: string;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface ForkUsagePort {
  record(input: {
    readonly organizationId: string;
    readonly projectId: string | null;
    readonly runId: string | null;
    readonly operationKey: string;
    readonly idempotencyKey: string;
    readonly target: ForkActivityInput['target'];
  }): Promise<unknown>;
}

export interface ForkActivity {
  execute(input: unknown): Promise<ForkActivityResult>;
}

export interface ForkActivityDependencies {
  readonly sources: ForkSourcePort;
  readonly entities: ForkEntityPort;
  readonly git: ForkGitPort;
  readonly context: ForkContextPort;
  readonly deployments: ForkDeploymentPort;
  readonly releases: ForkReleasePort;
  readonly usage: ForkUsagePort;
}

export class ForkSourceNotFoundError extends Error {
  constructor() {
    super('fork source not found');
    this.name = 'ForkSourceNotFoundError';
  }
}

export class ForkInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForkInvariantError';
  }
}

function stableId(prefix: 'proj' | 'br' | 'run' | 'ws' | 'art', seed: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(seed).digest();
  let bits = 0;
  let value = 0;
  let suffix = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && suffix.length < 26) {
      bits -= 5;
      suffix += alphabet[(value >>> bits) & 31] ?? '';
    }
    if (suffix.length === 26) break;
  }
  return `${prefix}_${suffix}`;
}

function forkSeed(input: ForkActivityInput, step: string): string {
  return `${input.destinationOrganizationId}:${input.operationKey}:${step}`;
}

function mutationKey(input: ForkActivityInput, step: string): string {
  return `op_${createHash('sha256').update(forkSeed(input, step)).digest('hex')}`;
}

function exactProjectSource(input: z.infer<typeof ProjectForkInputSchema>, raw: unknown) {
  const source = ProjectForkSourceSchema.safeParse(raw);
  if (!source.success) throw new ForkSourceNotFoundError();
  if (
    source.data.organizationId !== input.sourceOrganizationId ||
    source.data.projectId !== input.sourceProjectId
  ) {
    throw new ForkInvariantError('project source identity mismatch');
  }
  return source.data;
}

function exactRunSource(
  input: z.infer<typeof ConversationForkInputSchema> | z.infer<typeof CheckpointForkInputSchema>,
  raw: unknown,
) {
  const source = RunForkSourceSchema.safeParse(raw);
  if (!source.success) throw new ForkSourceNotFoundError();
  if (
    source.data.organizationId !== input.sourceOrganizationId ||
    source.data.runId !== input.sourceRunId
  ) {
    throw new ForkInvariantError('run source identity mismatch');
  }
  return source.data;
}

async function recordUsage(
  usage: ForkUsagePort,
  input: ForkActivityInput,
  projectId: string | null,
  runId: string | null,
): Promise<void> {
  const raw = await usage.record({
    organizationId: input.destinationOrganizationId,
    projectId,
    runId,
    operationKey: input.operationKey,
    idempotencyKey: mutationKey(input, 'usage'),
    target: input.target,
  });
  const parsed = z
    .object({ organizationId: idSchema('org') })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success || parsed.data.organizationId !== input.destinationOrganizationId) {
    throw new ForkInvariantError('fork usage was not attributed to the destination organization');
  }
}

async function linkedContext(
  dependencies: ForkActivityDependencies,
  input: z.infer<typeof ConversationForkInputSchema> | z.infer<typeof CheckpointForkInputSchema>,
  source: RunForkSource,
  runId: string,
  artifactId: string,
): Promise<string> {
  const raw = await dependencies.context.compactAndLink({
    sourceOrganizationId: input.sourceOrganizationId,
    sourceRunId: input.sourceRunId,
    destinationOrganizationId: input.destinationOrganizationId,
    destinationProjectId: input.destinationProjectId,
    destinationRunId: runId,
    destinationArtifactId: artifactId,
    operationKey: input.operationKey,
    idempotencyKey: mutationKey(input, 'context'),
  });
  const parsed = z
    .object({ artifactId: idSchema('art'), sourceRunId: idSchema('run') })
    .strict()
    .parse(raw);
  if (parsed.sourceRunId !== source.runId || parsed.artifactId !== artifactId) {
    throw new ForkInvariantError('compacted context provenance mismatch');
  }
  if (source.artifactIds.includes(parsed.artifactId)) {
    throw new ForkInvariantError('a fork cannot overwrite a source artifact');
  }
  return parsed.artifactId;
}

export function createForkActivity(dependencies: ForkActivityDependencies): ForkActivity {
  return {
    async execute(untrustedInput) {
      const input = ForkActivityInputSchema.parse(untrustedInput);

      if (input.target === 'project') {
        const source = exactProjectSource(
          input,
          await dependencies.sources.project({
            sourceOrganizationId: input.sourceOrganizationId,
            sourceProjectId: input.sourceProjectId,
          }),
        );
        const projectId = stableId('proj', forkSeed(input, 'project'));
        const branchId = stableId('br', forkSeed(input, 'default-branch'));
        if (projectId === source.projectId) {
          throw new ForkInvariantError('a project fork must have a new identity');
        }
        const { deploymentConfiguration, ...entitySource } = source;
        const created = await dependencies.entities.createProject({
          projectId,
          branchId,
          destinationOrganizationId: input.destinationOrganizationId,
          actorId: input.actorId,
          operationKey: input.operationKey,
          idempotencyKey: mutationKey(input, 'project-entity'),
          name: input.name,
          source: entitySource,
          copyRepository: () =>
            dependencies.git.copyRepository({
              sourceOrganizationId: input.sourceOrganizationId,
              sourceProjectId: input.sourceProjectId,
              destinationOrganizationId: input.destinationOrganizationId,
              destinationProjectId: projectId,
              defaultBranch: source.defaultBranch,
              operationKey: input.operationKey,
              idempotencyKey: mutationKey(input, 'repository-copy'),
            }),
        });
        if (created.projectId !== projectId || created.branchId !== branchId) {
          throw new ForkInvariantError('project fork result identity mismatch');
        }
        let deploymentConfigCopied = false;
        if (input.copyDeploymentConfig && deploymentConfiguration !== null) {
          await dependencies.deployments.copyConfiguration({
            sourceOrganizationId: input.sourceOrganizationId,
            sourceProjectId: input.sourceProjectId,
            destinationOrganizationId: input.destinationOrganizationId,
            destinationProjectId: projectId,
            configuration: deploymentConfiguration,
            operationKey: input.operationKey,
            idempotencyKey: mutationKey(input, 'deployment-configuration'),
          });
          deploymentConfigCopied = true;
        }
        const secretSetupChecklist =
          input.sourceOrganizationId === input.destinationOrganizationId
            ? []
            : [...new Set(source.secretNames)].sort();
        const result = ProjectForkResultSchema.parse({
          target: 'project',
          sourceProjectId: source.projectId,
          projectId,
          branchId,
          secretSetupChecklist,
          deploymentConfigCopied,
        });
        await recordUsage(dependencies.usage, input, result.projectId, null);
        return result;
      }

      if (input.target === 'branch') {
        const branchId = stableId('br', forkSeed(input, 'branch'));
        const created = await dependencies.entities.createBranch({
          branchId,
          organizationId: input.destinationOrganizationId,
          projectId: input.projectId,
          name: input.name,
          fromSha: input.fromSha,
          operationKey: input.operationKey,
          idempotencyKey: mutationKey(input, 'branch-entity'),
          createBranchRef: () =>
            dependencies.git.createBranchRef({
              organizationId: input.destinationOrganizationId,
              projectId: input.projectId,
              name: input.name,
              fromSha: input.fromSha,
              operationKey: input.operationKey,
              idempotencyKey: mutationKey(input, 'branch-ref'),
            }),
        });
        if (created.branchId !== branchId) {
          throw new ForkInvariantError('branch fork result identity mismatch');
        }
        const result = BranchForkResultSchema.parse({
          target: 'branch',
          projectId: input.projectId,
          branchId,
          headCommitSha: input.fromSha,
        });
        await recordUsage(dependencies.usage, input, result.projectId, null);
        return result;
      }

      if (input.target === 'conversation' || input.target === 'run_checkpoint') {
        const source = exactRunSource(
          input,
          await dependencies.sources.run({
            sourceOrganizationId: input.sourceOrganizationId,
            sourceRunId: input.sourceRunId,
          }),
        );
        if (
          input.target === 'run_checkpoint' &&
          !source.checkpointRefs.includes(input.checkpointRef)
        ) {
          throw new ForkSourceNotFoundError();
        }
        const runId = stableId('run', forkSeed(input, 'run'));
        const contextArtifactId = stableId('art', forkSeed(input, 'context'));
        if (runId === source.runId) {
          throw new ForkInvariantError('a run fork must have a new identity');
        }
        await linkedContext(dependencies, input, source, runId, contextArtifactId);
        const created = await dependencies.entities.createRun({
          runId,
          destinationOrganizationId: input.destinationOrganizationId,
          destinationProjectId: input.destinationProjectId,
          destinationBranchId: input.destinationBranchId,
          actorId: input.actorId,
          operationKey: input.operationKey,
          idempotencyKey: mutationKey(input, 'run-entity'),
          source,
          contextArtifactId,
          kind: input.target,
        });
        if (created.runId !== runId) {
          throw new ForkInvariantError('run fork result identity mismatch');
        }
        if (input.target === 'conversation') {
          const result = ConversationForkResultSchema.parse({
            target: 'conversation',
            sourceRunId: source.runId,
            runId,
            contextArtifactId,
          });
          await recordUsage(
            dependencies.usage,
            input,
            input.destinationProjectId,
            result.runId,
          );
          return result;
        }

        const workspaceId = stableId('ws', forkSeed(input, 'workspace'));
        const restored = await dependencies.context.restoreCheckpoint({
          sourceOrganizationId: input.sourceOrganizationId,
          sourceRunId: source.runId,
          destinationOrganizationId: input.destinationOrganizationId,
          destinationProjectId: input.destinationProjectId,
          destinationBranchId: input.destinationBranchId,
          destinationRunId: runId,
          workspaceId,
          checkpointRef: input.checkpointRef,
          operationKey: input.operationKey,
          idempotencyKey: mutationKey(input, 'checkpoint-restore'),
        });
        if (
          restored.workspaceId !== workspaceId ||
          restored.checkpointRef !== input.checkpointRef
        ) {
          throw new ForkInvariantError('checkpoint restore result identity mismatch');
        }
        const result = CheckpointForkResultSchema.parse({
          target: 'run_checkpoint',
          sourceRunId: source.runId,
          runId,
          workspaceId,
          contextArtifactId,
          checkpointRef: input.checkpointRef,
        });
        await recordUsage(dependencies.usage, input, input.destinationProjectId, result.runId);
        return result;
      }

      const branchId = stableId('br', forkSeed(input, 'repair-branch'));
      const fixRunId = stableId('run', forkSeed(input, 'fix-run'));
      const delegated = z
        .object({
          releaseId: idSchema('rel'),
          branchId: idSchema('br'),
          fixRunId: idSchema('run').nullable(),
        })
        .strict()
        .parse(
          await dependencies.releases.forkRelease({
            sourceOrganizationId: input.sourceOrganizationId,
            destinationOrganizationId: input.destinationOrganizationId,
            releaseId: input.releaseId,
            branchId,
            branchName: `fix/rel-${input.releaseId}`,
            fixRunId,
            startFixRun: input.startFixRun,
            actorId: input.actorId,
            operationKey: input.operationKey,
            idempotencyKey: mutationKey(input, 'release-repair'),
          }),
        );
      if (
        delegated.releaseId !== input.releaseId ||
        delegated.branchId !== branchId ||
        delegated.fixRunId !== (input.startFixRun ? fixRunId : null)
      ) {
        throw new ForkInvariantError('release fork delegation identity mismatch');
      }
      const result = ReleaseRepairForkResultSchema.parse({
        target: 'release_repair',
        ...delegated,
      });
      await recordUsage(dependencies.usage, input, null, result.fixRunId);
      return result;
    },
  };
}

export function createUnavailableForkActivity(): ForkActivity {
  return {
    execute() {
      return Promise.reject(new Error('fork activity unavailable'));
    },
  };
}
