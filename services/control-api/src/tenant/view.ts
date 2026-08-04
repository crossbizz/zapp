import { AgentEventVisibilitySchema, RunModeSchema, SupportLevelSchema } from '@zapp/contracts';
import type {
  AgentEventRow,
  AgentRun,
  Branch,
  Environment,
  Project,
  ProjectContract,
  Repository,
} from '@zapp/db';
import { z } from 'zod';

/**
 * What a tenant-scoped row looks like on the wire.
 *
 * Kept out of `src/routes/` deliberately: mapping a row needs its Drizzle type,
 * and a route module that imports from `@zapp/db` — even for a type — is a route
 * module one edit away from importing a table. The convention that route files
 * reach no database handle is checked by grep
 * (`test/route-isolation.test.ts`), and a grep cannot tell a type import from a
 * value one, so the types live here instead of weakening the rule.
 *
 * Every schema carries `organizationId`. That is not decoration: it is what lets
 * a client — and `test/integration/tenant-isolation.test.ts` — assert that every
 * row in an answer belongs to the tenant that asked, rather than trusting that
 * it does.
 */

export const ProjectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  sourceType: z.string(),
  supportLevel: SupportLevelSchema,
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

/**
 * The repository a project's code lives in (PRD §19.1). `internalRepoRef` is the
 * `owner/name` of the internal Forgejo repository and is safe to show: it is
 * derived from ids the caller already holds and carries no credential — cloning
 * it still needs a token the git service mints per workspace (plan 06).
 */
export const RepositorySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  provider: z.string(),
  internalRepoRef: z.string(),
  externalRepoRef: z.string().nullable(),
  defaultBranch: z.string(),
  syncPolicy: z.string(),
});

export const BranchSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** Null on an unborn branch — the row exists before the first commit lands. */
  headCommitSha: z.string().nullable(),
  baseBranchId: z.string().nullable(),
  status: z.string(),
});

export const EnvironmentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  name: z.string(),
  type: z.string(),
  deploymentProvider: z.string().nullable(),
  databaseConnectionId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const ProjectContractSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  /** Monotonic per project: a scan appends a version, never overwrites one (PRD §17.2). */
  version: z.number().int(),
  detectedFramework: z.string().nullable(),
  /**
   * The `ExecutionContract` document (PRD §17.2), passed through as stored.
   * `unknown` rather than `ExecutionContractSchema` for the reason
   * {@link EventSchema.payload} is: the column is `jsonb`, the writer (plan 05
   * VF-3) is what validates on the way in, and re-validating on the way out
   * would turn a contract written by a newer schema version into a 500 for a
   * client that only wanted to read it.
   */
  contract: z.unknown(),
  createdAt: z.string().datetime(),
});

export const RunSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  branchId: z.string().nullable(),
  mode: RunModeSchema,
  status: z.string(),
  startedBy: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export const EventSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  runId: z.string(),
  /** 1-based and gapless per run; what a resuming client passes back (CP-15). */
  sequence: z.number().int(),
  type: z.string(),
  visibility: AgentEventVisibilitySchema,
  occurredAt: z.string().datetime(),
  /**
   * `jsonb`, which Drizzle types as `unknown` — honestly, since nothing in the
   * database constrains its shape. PRD §14.4's per-type payload contracts are
   * `@zapp/contracts`' to enforce when CP-15 owns the stream.
   */
  payload: z.unknown(),
});

export function toProject(project: Project): z.infer<typeof ProjectSchema> {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    description: project.description,
    sourceType: project.sourceType,
    supportLevel: project.supportLevel,
    createdBy: project.createdBy,
    createdAt: project.createdAt.toISOString(),
    archivedAt: project.archivedAt?.toISOString() ?? null,
  };
}

export function toRepository(repository: Repository): z.infer<typeof RepositorySchema> {
  return {
    id: repository.id,
    organizationId: repository.organizationId,
    projectId: repository.projectId,
    provider: repository.provider,
    internalRepoRef: repository.internalRepoRef,
    externalRepoRef: repository.externalRepoRef,
    defaultBranch: repository.defaultBranch,
    syncPolicy: repository.syncPolicy,
  };
}

export function toBranch(branch: Branch): z.infer<typeof BranchSchema> {
  return {
    id: branch.id,
    organizationId: branch.organizationId,
    projectId: branch.projectId,
    name: branch.name,
    headCommitSha: branch.headCommitSha,
    baseBranchId: branch.baseBranchId,
    status: branch.status,
  };
}

export function toEnvironment(environment: Environment): z.infer<typeof EnvironmentSchema> {
  return {
    id: environment.id,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    name: environment.name,
    type: environment.type,
    deploymentProvider: environment.deploymentProvider,
    databaseConnectionId: environment.databaseConnectionId,
    createdAt: environment.createdAt.toISOString(),
  };
}

export function toProjectContract(
  contract: ProjectContract,
): z.infer<typeof ProjectContractSchema> {
  return {
    id: contract.id,
    organizationId: contract.organizationId,
    projectId: contract.projectId,
    version: contract.version,
    detectedFramework: contract.detectedFramework,
    contract: contract.contractJson,
    createdAt: contract.createdAt.toISOString(),
  };
}

export function toRun(run: AgentRun): z.infer<typeof RunSchema> {
  return {
    id: run.id,
    organizationId: run.organizationId,
    projectId: run.projectId,
    branchId: run.branchId,
    mode: run.mode,
    status: run.status,
    startedBy: run.startedBy,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export function toEvent(event: AgentEventRow): z.infer<typeof EventSchema> {
  return {
    id: event.id,
    organizationId: event.organizationId,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    visibility: event.visibility,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payloadJson,
  };
}
