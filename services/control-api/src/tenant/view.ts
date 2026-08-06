import {
  AgentEventVisibilitySchema,
  AppTypeSchema,
  ModelIdentifierSchema,
  ResourceProfileSchema,
  RunModeSchema,
  SupportLevelSchema,
  WorkspaceStatusSchema,
} from '@zapp/contracts';
import type {
  AgentEventRow,
  AgentRun,
  Branch,
  Environment,
  Project,
  ProjectContract,
  Repository,
  SecretMetadata,
  Specification,
  Workspace,
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

/**
 * Temporary CP-10 local schema for PRD §12.2. AR-16 owns the shared schema;
 * this remains strict until that replacement is available.
 */
const SpecificationTextSchema = z.string().trim().min(1).max(20_000);
const SpecificationTextListSchema = z.array(SpecificationTextSchema).min(1).max(200);
const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-[1-9][0-9]*$/, 'Acceptance criterion ids must be AC-n.'),
    text: SpecificationTextSchema,
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    criticalFlow: z.boolean(),
  })
  .strict();

export const SpecificationContentSchema = z
  .object({
    problem: SpecificationTextSchema,
    targetUsers: SpecificationTextListSchema,
    goals: SpecificationTextListSchema,
    nonGoals: SpecificationTextListSchema,
    journeys: SpecificationTextListSchema,
    pagesRoutes: SpecificationTextListSchema,
    rolesPermissions: SpecificationTextListSchema,
    dataModel: SpecificationTextListSchema,
    integrations: SpecificationTextListSchema,
    functionalRequirements: SpecificationTextListSchema,
    nonfunctionalRequirements: SpecificationTextListSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(200),
    assumptions: SpecificationTextListSchema,
    risks: SpecificationTextListSchema,
    definitionOfDone: SpecificationTextListSchema,
  })
  .strict();

export const SpecificationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'approved']),
  content: SpecificationContentSchema,
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().datetime().nullable(),
});

export const SpecificationResponseSchema = z.object({ specification: SpecificationSchema });
export type SpecificationContent = z.infer<typeof SpecificationContentSchema>;
export type SpecificationView = z.infer<typeof SpecificationSchema>;
export type SpecificationResponse = z.infer<typeof SpecificationResponseSchema>;

/**
 * A secret, as every API response is allowed to describe one: its name, its
 * scope, who set it and when, and which master key generation wrapped it
 * (PRD §32.5, plan 02 CP-7).
 *
 * There is no `value` field, and that is not an omission to be re-checked at
 * review time — it is unrepresentable twice over. The schema does not declare
 * one, so the serializer would strip it; and {@link toSecretMetadata} takes a
 * `SecretMetadata` row, which has no ciphertext column to map from because the
 * ciphertext lives on a different table (`packages/db/src/schema/security.ts`).
 * A future edit that wanted to leak a value would have to add a column, a query
 * and a field, in three files, on purpose.
 *
 * `encryptedValueRef` is likewise absent: it is an internal locator, it tells a
 * client nothing it can act on, and a pointer into the vault is not a thing to
 * publish even when following it needs a key nobody has.
 */
export const SecretMetadataSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string().nullable(),
  /** Null means the secret applies to every environment of its project. */
  environmentId: z.string().nullable(),
  name: z.string(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  /** Null until the secret has been rotated at least once. */
  rotatedAt: z.string().datetime().nullable(),
  keyVersion: z.number().int(),
});

/** PRD §23.5 release rows, rendered without provider-side identities. */
export const ReleaseSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    projectId: z.string(),
    environmentId: z.string(),
    commitSha: z.string(),
    specificationId: z.string().nullable(),
    status: z.string(),
    evidenceManifestArtifactId: z.string().nullable(),
    createdBy: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Safe PRD §23.6 connection view. Credential material is intentionally absent. */
export const IntegrationConnectionSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    projectId: z.string().nullable(),
    provider: z.enum(['github', 'supabase', 'neon', 'stripe']),
    status: z.string().min(1),
    credentialRef: z.string().nullable(),
    configuration: z
      .union([
        z.object({ installationId: z.string().min(1) }).strict(),
        z.object({ projectRef: z.string().min(1) }).strict(),
        z.object({ projectId: z.string().min(1) }).strict(),
        z.object({ accountId: z.string().min(1), mode: z.enum(['test', 'live']) }).strict(),
      ]),
  })
  .strict();

export type ReleaseView = z.infer<typeof ReleaseSchema>;
export type IntegrationConnectionView = z.infer<typeof IntegrationConnectionSchema>;

export const RunSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  branchId: z.string().nullable(),
  mode: RunModeSchema,
  appType: AppTypeSchema,
  model: ModelIdentifierSchema.nullable(),
  status: z.string(),
  startedBy: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export const WorkspaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  branchId: z.string().nullable(),
  provider: z.string(),
  providerWorkspaceId: z.string().nullable(),
  status: WorkspaceStatusSchema,
  resourceProfile: ResourceProfileSchema,
  snapshotRef: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastActiveAt: z.string().datetime().nullable(),
  terminatedAt: z.string().datetime().nullable(),
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

export function toSpecification(specification: Specification): SpecificationView {
  return SpecificationSchema.parse({
    id: specification.id,
    organizationId: specification.organizationId,
    projectId: specification.projectId,
    version: specification.version,
    status: specification.status,
    content: specification.contentJson,
    createdBy: specification.createdBy,
    approvedBy: specification.approvedBy,
    approvedAt: specification.approvedAt?.toISOString() ?? null,
  });
}

export function toSecretMetadata(secret: SecretMetadata): z.infer<typeof SecretMetadataSchema> {
  return {
    id: secret.id,
    organizationId: secret.organizationId,
    projectId: secret.projectId,
    environmentId: secret.environmentId,
    name: secret.name,
    createdBy: secret.createdBy,
    createdAt: secret.createdAt.toISOString(),
    rotatedAt: secret.rotatedAt?.toISOString() ?? null,
    keyVersion: secret.keyVersion,
  };
}

export function toRun(run: AgentRun): z.infer<typeof RunSchema> {
  return {
    id: run.id,
    organizationId: run.organizationId,
    projectId: run.projectId,
    branchId: run.branchId,
    mode: run.mode,
    appType: run.appType,
    model: run.model,
    status: run.status,
    startedBy: run.startedBy,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export function toWorkspace(workspace: Workspace): z.infer<typeof WorkspaceSchema> {
  return {
    ...workspace,
    resourceProfile: ResourceProfileSchema.parse(workspace.resourceProfile),
    createdAt: workspace.createdAt.toISOString(),
    lastActiveAt: workspace.lastActiveAt?.toISOString() ?? null,
    terminatedAt: workspace.terminatedAt?.toISOString() ?? null,
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
