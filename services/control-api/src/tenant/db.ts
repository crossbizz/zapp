import {
  type AgentEvent,
  newId,
  type ResourceProfile,
  type RunMode,
  type SupportLevel,
  type WorkspaceStatus,
} from '@zapp/contracts';
import {
  agentEvents,
  agentPhases,
  agentRuns,
  agentTasks,
  auditEvents,
  branches,
  environments,
  forOrg,
  MAX_EVENT_PAYLOAD_BYTES,
  projectContracts,
  projects,
  repositories,
  secretCiphertexts,
  secretMetadata,
  specifications,
  workspaces,
  nextEventSequence,
  type AgentEventRow,
  type AuditEvent,
  type Branch,
  type AgentRun,
  type Database,
  type Environment,
  type EventRepository,
  type Project,
  type ProjectContract,
  type ProjectRepository,
  type Repository,
  type SecretMetadata,
  type Specification,
  type TenantDb,
  type Workspace,
} from '@zapp/db';
import { and, asc, desc, eq, gte, isNull, lt, lte, sql, type Column, type SQL } from 'drizzle-orm';

import { isUniqueViolation } from '../db/errors.js';
import type { PageRequest, StorePage } from '../pagination.js';
import type { AuditHook } from '../plugins/audit.js';
import type { SecretEnvelope } from '../secrets/crypto.js';
import {
  BRANCH_ACTIVE,
  DEFAULT_BRANCH,
  DEFAULT_ENVIRONMENTS,
  INTERNAL_PROVIDER,
  NO_SYNC,
  type SourceType,
} from './vocabulary.js';

/**
 * The only database handle a route handler is ever given.
 *
 * `forOrg` (plan 01 FND-6) builds the read side that plan 01 owns: every query it
 * makes carries `organization_id = <the tenant>` in its own WHERE clause, so a
 * caller holding one cannot express a cross-tenant read. What it deliberately
 * does not build is the write side — an insert has to *set* `organization_id`
 * rather than filter by it, and `packages/db` refuses to hide that.
 *
 * This is where it stops being hidden and starts being impossible to get wrong:
 * every statement below takes the organization from the handle it was built
 * with, never from its arguments and never from a request body. A handler that
 * wanted to file a row under another tenant has no parameter to do it with, and
 * one that wanted to read another tenant's rows has no query that omits the
 * predicate — {@link scoped} is the only way a statement in this file names a
 * table, and it applies the organization itself.
 *
 * Everything reachable from here is scoped. Nothing else is exported to a
 * route — see `src/plugins/tenant.ts` and `test/route-isolation.test.ts`.
 */

/**
 * What creating a project writes, and what reading one back returns.
 *
 * A project is not a row, it is a set of rows that only make sense together: the
 * project, the repository its code lives in, the branch that repository starts
 * on, and the environments it deploys to. They are created in one transaction
 * and returned together, so a client never has to make three calls to learn
 * whether creation half-succeeded.
 */
export interface ProjectResources {
  readonly project: Project;
  readonly repository: Repository;
  /** Just the default branch at creation; every branch of the project on a read. */
  readonly branches: Branch[];
  readonly environments: Environment[];
}

/** What the repository callback is told about the project being created. */
export interface RepositoryRequest {
  readonly project: Project;
  /** The branch the store is about to write, so the two cannot disagree. */
  readonly defaultBranch: string;
}

export interface NewProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  /** How the project entered zapp — one of {@link SOURCE_TYPES}. */
  readonly sourceType: SourceType;
  /**
   * Where every project starts. Not a parameter: PRD §7.1's tiers are *earned*
   * by what the capability scan finds (plan 05 VF-3), so there is deliberately
   * no way for a caller to declare its own project verified.
   */
  readonly supportLevel: SupportLevel;
  readonly createdBy: string;
  readonly now: Date;
  /**
   * Creates the internal repository, **inside the transaction**. A refusal rolls
   * the project, its branch and its environments back with it: a project whose
   * code has nowhere to live is worse than no project at all, and an orphan row
   * is what a client would then retry into a slug collision.
   *
   * A callback rather than the port itself, for the same reason
   * `CreateOrganizationInput.link` is one: the route owns which port it calls and
   * how a failure is reported, and this module owns when it runs — and *what*
   * it runs with, which is why the branch name is an argument rather than
   * something the caller has to spell identically.
   */
  readonly repository: (request: RepositoryRequest) => Promise<{
    readonly internalRepoRef: string;
    /**
     * When the repository actually came into existence. Absent from a
     * record-only implementation, and that absence is exactly what
     * `repositories.provisioned_at` records — see
     * `src/git/port.ts#CreatedRepository`.
     */
    readonly provisionedAt?: Date;
  }>;
  /**
   * Runs last, still inside the transaction, so the `audit_events` row and
   * everything it describes commit together or not at all (plan 02 CP-5).
   */
  readonly audit: AuditHook<ProjectResources>;
}

/** What a `PATCH` may move. `description: null` clears it; absent leaves it. */
export interface ProjectPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  /** True archives the project, false restores it (PRD §23.2 `archived_at`). */
  readonly archived?: boolean;
}

export interface UpdateProjectInput {
  readonly projectId: string;
  readonly patch: ProjectPatch;
  readonly now: Date;
  readonly audit: AuditHook<Project>;
}

/**
 * The one outcome of a write that is not an error: the slug is unique *per
 * organization* (two tenants may both own `checkout`), so a collision is a
 * normal answer the caller decides what to do about — retry with a suffix when
 * the slug was derived, 409 when the client chose it. Reported rather than
 * thrown, so no route module has to import an error class from the database
 * layer to handle it.
 */
export type CreatedProject = ProjectResources | 'slug_taken';

/** `undefined` when the project is not this tenant's, or does not exist. */
export type UpdatedProject = Project | 'slug_taken' | undefined;

export interface ProjectListRequest extends PageRequest {
  /** Archived projects are hidden by default; a client asks for them explicitly. */
  readonly includeArchived?: boolean;
}

/**
 * `list` deliberately replaces `ProjectRepository`'s rather than sitting beside
 * it: master plan §7 requires every list endpoint to be keyset-paginated, and a
 * handle that still offered an unbounded "all of them" is a handle a future
 * route will use. Nothing in this service can ask for every project of a tenant
 * in one query.
 */
export interface TenantProjectRepository extends Omit<ProjectRepository, 'list'> {
  list(request: ProjectListRequest): Promise<StorePage<Project>>;
  create(input: NewProjectInput): Promise<CreatedProject>;
  update(input: UpdateProjectInput): Promise<UpdatedProject>;
}

export interface TenantRepositoryRepository {
  /** The project's repository; `undefined` for another tenant's project. */
  forProject(projectId: string): Promise<Repository | undefined>;
}

export interface TenantBranchRepository {
  /** The project's branches, newest first; empty for another tenant's project. */
  byProject(projectId: string): Promise<Branch[]>;
  /** One branch only when both it and its project belong to this tenant. */
  getForProject(projectId: string, branchId: string): Promise<Branch | undefined>;
}

export interface TenantEnvironmentRepository {
  /** The project's environments, oldest first; empty for another tenant's project. */
  byProject(projectId: string): Promise<Environment[]>;
  /** One environment only when it and its project belong to this tenant. */
  getForProject(projectId: string, environmentId: string): Promise<Environment | undefined>;
}

export interface TenantContractRepository {
  /**
   * The newest `project_contracts` row, or `undefined` when the project has
   * never been scanned. Versions are monotonic per project and a scan appends
   * one rather than overwriting (PRD §17.2), so "latest" is "highest version".
   */
  latestForProject(projectId: string): Promise<ProjectContract | undefined>;
}

export interface NewSpecificationInput {
  readonly id: string;
  readonly projectId: string;
  readonly content: unknown;
  readonly createdBy: string;
  readonly now: Date;
  readonly audit: AuditHook<Specification>;
}

export interface UpdateSpecificationInput {
  readonly projectId: string;
  readonly version: number;
  readonly content: unknown;
  readonly operationKey: string;
  readonly audit: AuditHook<Specification>;
}

export interface ApproveSpecificationInput {
  readonly projectId: string;
  readonly version: number;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly operationKey: string;
  readonly audit: AuditHook<Specification>;
}

export type UpdatedSpecification = Specification | 'immutable' | undefined;

/** All specification writes lock their tenant project before reading the next version. */
export interface TenantSpecificationRepository {
  getByProjectVersion(projectId: string, version: number): Promise<Specification | undefined>;
  /** One specification only when it and its project belong to this tenant. */
  getForProject(projectId: string, specificationId: string): Promise<Specification | undefined>;
  create(input: NewSpecificationInput): Promise<Specification>;
  update(input: UpdateSpecificationInput): Promise<UpdatedSpecification>;
  approve(input: ApproveSpecificationInput): Promise<Specification | undefined>;
}

/** The one run write CP-9 owns: persist then start its durable workflow atomically. */
export interface NewRunInput {
  readonly id: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly branchId: string | null;
  readonly mode: RunMode;
  readonly budget: unknown;
  readonly startedBy: string;
  readonly now: Date;
  readonly audit: AuditHook<AgentRun>;
}

export type OperationOutcome = 'dispatch' | 'completed' | 'rejected' | 'blocked';

export interface OperationClaim<T> {
  readonly entity: T;
  readonly outcome: OperationOutcome;
  /** The durable audit metadata for a prior completed/rejected operation. */
  readonly metadata?: unknown;
}

export interface ClaimRunOperationInput {
  readonly runId: string;
  readonly operationKey: string;
  readonly allowedStatuses: readonly string[];
  readonly audit: AuditHook<AgentRun>;
}

export interface CompleteRunOperationInput {
  readonly runId: string;
  readonly operationKey: string;
  readonly expectedStatus: string;
  readonly status: string;
  readonly completedAt: Date | null;
  readonly audit: AuditHook<AgentRun>;
}

export interface TenantRunRepository extends Omit<TenantDb['runs'], 'byProject'> {
  byProject(projectId: string): Promise<AgentRun[]>;
  create(input: NewRunInput): Promise<AgentRun>;
  claimOperation(input: ClaimRunOperationInput): Promise<OperationClaim<AgentRun> | undefined>;
  completeOperation(input: CompleteRunOperationInput): Promise<AgentRun | undefined>;
  rejectOperation(
    input: Omit<CompleteRunOperationInput, 'expectedStatus' | 'status' | 'completedAt'>,
  ): Promise<AgentRun | undefined>;
}

export interface NewWorkspaceInput {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string | null;
  readonly resourceProfile: ResourceProfile;
  readonly now: Date;
  readonly audit: AuditHook<Workspace>;
}
export interface CompleteWorkspaceCreateInput {
  readonly workspaceId: string;
  readonly providerWorkspaceId: string;
  readonly status: WorkspaceStatus;
  readonly audit: AuditHook<Workspace>;
}
export interface ClaimWorkspaceOperationInput {
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly allowedStatuses: readonly WorkspaceStatus[];
  readonly audit: AuditHook<Workspace>;
}
export interface CompleteWorkspaceOperationInput {
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly expectedStatus: WorkspaceStatus;
  readonly status?: WorkspaceStatus;
  readonly snapshotRef?: string | null;
  readonly terminatedAt?: Date | null;
  readonly now: Date;
  readonly audit: AuditHook<Workspace>;
}
export interface TenantWorkspaceRepository {
  getById(workspaceId: string): Promise<Workspace | undefined>;
  create(input: NewWorkspaceInput): Promise<Workspace>;
  completeCreate(input: CompleteWorkspaceCreateInput): Promise<Workspace | undefined>;
  claimOperation(
    input: ClaimWorkspaceOperationInput,
  ): Promise<OperationClaim<Workspace> | undefined>;
  completeOperation(input: CompleteWorkspaceOperationInput): Promise<Workspace | undefined>;
  rejectOperation(
    input: Omit<
      CompleteWorkspaceOperationInput,
      'expectedStatus' | 'status' | 'snapshotRef' | 'terminatedAt' | 'now'
    >,
  ): Promise<Workspace | undefined>;
}

interface DurableOperation {
  readonly key: string;
  readonly state: 'requested' | 'completed' | 'rejected';
  readonly metadata: unknown;
}

function durableOperation(metadata: unknown): DurableOperation | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = metadata as Record<string, unknown>;
  if (
    typeof value['operationKey'] !== 'string' ||
    (value['operationState'] !== 'requested' &&
      value['operationState'] !== 'completed' &&
      value['operationState'] !== 'rejected')
  ) {
    return undefined;
  }
  return { key: value['operationKey'], state: value['operationState'], metadata };
}

/**
 * The vault (plan 02 CP-7).
 *
 * Two tables, and the split is load-bearing: `secret_metadata` carries the name,
 * the scope and the key version, and `secret_ciphertexts` carries the encrypted
 * value. {@link TenantSecretRepository.list} and `.getById` select from the
 * first only, so a metadata read has no ciphertext column in reach — the API's
 * "never values" promise (PRD §32.5) is a property of the query rather than of
 * the mapping that follows it. {@link TenantSecretRepository.readEnvelope} is
 * the *only* method that touches the second, it is called from exactly one place
 * (`src/secrets/vault.ts`, for the audited internal decrypt), and it will not
 * return a row without writing the audit entry for it.
 */
export interface NewSecretInput {
  readonly projectId: string;
  /** Null means every environment of the project (PRD §23.6). */
  readonly environmentId: string | null;
  readonly name: string;
  /** Already encrypted: this module never sees a plaintext value. */
  readonly envelope: SecretEnvelope;
  readonly createdBy: string;
  readonly now: Date;
  readonly audit: AuditHook<SecretMetadata>;
}

export interface RotateSecretInput {
  readonly secretId: string;
  readonly envelope: SecretEnvelope;
  readonly now: Date;
  readonly audit: AuditHook<SecretMetadata>;
}

export interface DeleteSecretInput {
  readonly secretId: string;
  readonly audit: AuditHook<SecretMetadata>;
}

export interface SecretListRequest extends PageRequest {
  readonly projectId: string;
}

/** What the audited read hands back, and the one shape carrying key material. */
export interface StoredSecret {
  readonly secret: SecretMetadata;
  readonly envelope: SecretEnvelope;
}

export interface ReadSecretInput {
  readonly secretId: string;
  /**
   * Runs inside the reading transaction, before it commits. Not optional, and
   * not a callback the caller may leave empty: a decrypt that returned key
   * material and left no row is the one outcome this table exists to prevent.
   */
  readonly audit: AuditHook<SecretMetadata>;
}

/** The one outcome of a write that is not an error — see {@link CreatedProject}. */
export type CreatedSecret = SecretMetadata | 'name_taken';

export interface TenantSecretRepository {
  /** Metadata only, keyset-paginated. Selects no ciphertext column. */
  list(request: SecretListRequest): Promise<StorePage<SecretMetadata>>;
  /** Metadata only; `undefined` for another tenant's secret, or one that does not exist. */
  getById(secretId: string): Promise<SecretMetadata | undefined>;
  create(input: NewSecretInput): Promise<CreatedSecret>;
  /** Overwrites the stored value and bumps `rotated_at`; `undefined` when not found. */
  rotate(input: RotateSecretInput): Promise<SecretMetadata | undefined>;
  /** Removes the metadata row; the ciphertext goes with it (ON DELETE CASCADE). */
  delete(input: DeleteSecretInput): Promise<SecretMetadata | undefined>;
  /**
   * The audited read of encrypted key material. `undefined` for another
   * tenant's secret — the handle is bound to one organization, so an internal
   * caller naming the wrong one gets the same answer as for a secret that never
   * existed.
   */
  readEnvelope(input: ReadSecretInput): Promise<StoredSecret | undefined>;
}

/** The caller-supplied half of PRD §14.4; CP-13 mints `id` and `sequence`. */
export type NewAgentEvent = Omit<AgentEvent, 'id' | 'sequence'>;

export interface IngestEventBatchInput {
  readonly runId: string;
  readonly projectId: string;
  readonly events: readonly NewAgentEvent[];
  /** One audit row, after the batch and notification statement but before commit. */
  readonly audit: AuditHook<readonly AgentEventRow[]>;
}

/** An ingest rejection that must not allocate a sequence or write an audit row. */
export type IngestEventBatchResult =
  | { readonly kind: 'stored'; readonly events: readonly AgentEventRow[] }
  | { readonly kind: 'run_not_found' }
  | { readonly kind: 'payload_too_large' };

export interface TenantEventRepository extends EventRepository {
  /** The only production writer for the immutable event log. */
  ingest(input: IngestEventBatchInput): Promise<IngestEventBatchResult>;
}

export interface AuditEventListRequest extends PageRequest {
  readonly actorId?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface TenantAuditEventRepository {
  list(request: AuditEventListRequest): Promise<StorePage<AuditEvent>>;
}

/** `TenantDb` (plan 01's reads) plus the project lifecycle the control plane owns. */
export interface TenantDatabase extends Omit<TenantDb, 'projects' | 'runs' | 'events'> {
  readonly projects: TenantProjectRepository;
  readonly runs: TenantRunRepository;
  readonly workspaces: TenantWorkspaceRepository;
  readonly repositories: TenantRepositoryRepository;
  readonly branches: TenantBranchRepository;
  readonly environments: TenantEnvironmentRepository;
  readonly contracts: TenantContractRepository;
  readonly specifications: TenantSpecificationRepository;
  readonly secrets: TenantSecretRepository;
  readonly events: TenantEventRepository;
  readonly auditEvents: TenantAuditEventRepository;
}

/**
 * Binds a database handle to one organization. The plugin calls this once per
 * request, with an id it has already checked an active membership for.
 */
export type TenantDbFactory = (organizationId: string) => TenantDatabase;

/**
 * The index that makes a project slug unique per organization
 * (`packages/db/drizzle/0000`). See `src/db/errors.ts` for why the name matters.
 */
const PROJECT_SLUG_CONSTRAINT = ['projects_org_slug_idx'];

/**
 * The two indexes that make a secret's name unique within its scope
 * (`packages/db/drizzle/0007`). Named so a conflict on one of them is reported
 * as `name_taken` and a conflict on anything else is not — see fold (d) of the
 * CP-6 review and `src/db/errors.ts`.
 */
const SECRET_NAME_CONSTRAINTS = [
  'secret_metadata_env_name_idx',
  'secret_metadata_project_name_idx',
];

/**
 * `secret_metadata.encrypted_value_ref`: which vault holds the ciphertext, and
 * where in it. `pg:` is the P0 backend — the `secret_ciphertexts` row with this
 * secret's id — and a later row pointing at a KMS-fronted store says so with a
 * different scheme rather than by being absent from this table.
 */
export function vaultRef(secretId: string): string {
  return `pg:secret_ciphertexts/${secretId}`;
}

export function createTenantDbFactory(db: Database): TenantDbFactory {
  return (organizationId: string): TenantDatabase => {
    // `forOrg` validates the id rather than trusting it, which is what turns a
    // bad id into a loud failure here instead of a silently empty query later.
    const base = forOrg(db, organizationId);
    const orgId = base.organizationId;

    /**
     * The organization predicate, and the only way a statement in this file
     * refers to a tenant column.
     *
     * Written as a function taking the table's own `organization_id` so every
     * query has to name it — there is no overload that omits the tenant, so
     * "I forgot the `where organization_id =`" is not a mistake this module can
     * make either. The same rule `forOrg` applies to plan 01's reads, applied to
     * plan 02's.
     */
    const scoped = (column: Column, ...rest: SQL[]): SQL =>
      // `and` returns `SQL | undefined` only when given nothing; it is given at
      // least the tenant predicate here, so the assertion describes a fact.
      and(eq(column, orgId), ...rest) as SQL;

    return {
      ...base,

      events: {
        ...base.events,
        async ingest(input: IngestEventBatchInput): Promise<IngestEventBatchResult> {
          return await db.transaction(async (tx) => {
            // The route rejects oversized serialized JSON cheaply. This exact
            // PostgreSQL check is still required: jsonb's datum overhead can
            // exceed the CHECK limit even when JSON.stringify is 65,536 bytes.
            for (const event of input.events) {
              const [payload] = await tx.execute<{ size: number }>(
                sql`select pg_column_size(${JSON.stringify(event.payload)}::jsonb) as size`,
              );
              if (payload === undefined) throw new Error('failed to measure event payload');
              if (payload.size > MAX_EVENT_PAYLOAD_BYTES) return { kind: 'payload_too_large' };
            }

            // This is deliberately the first statement in the transaction. The
            // allocator has no tenant argument, so looking the run up afterward
            // would create a gap for a foreign or malformed request.
            const [run] = await tx
              .select()
              .from(agentRuns)
              .where(scoped(agentRuns.organizationId, eq(agentRuns.id, input.runId)))
              .limit(1);
            if (run === undefined || run.projectId !== input.projectId) return { kind: 'run_not_found' };

            for (const event of input.events) {
              if (event.phaseId !== undefined) {
                const [phase] = await tx
                  .select({ id: agentPhases.id })
                  .from(agentPhases)
                  .where(
                    scoped(
                      agentPhases.organizationId,
                      eq(agentPhases.id, event.phaseId),
                      eq(agentPhases.runId, input.runId),
                    ),
                  )
                  .limit(1);
                if (phase === undefined) return { kind: 'run_not_found' };
              }
              if (event.taskId !== undefined) {
                const [task] = await tx
                  .select({ phaseId: agentTasks.phaseId })
                  .from(agentTasks)
                  .innerJoin(agentPhases, eq(agentPhases.id, agentTasks.phaseId))
                  .where(
                    scoped(
                      agentTasks.organizationId,
                      eq(agentTasks.id, event.taskId),
                      eq(agentPhases.runId, input.runId),
                    ),
                  )
                  .limit(1);
                if (task === undefined || (event.phaseId !== undefined && task.phaseId !== event.phaseId)) {
                  return { kind: 'run_not_found' };
                }
              }
            }

            const pending: (typeof agentEvents.$inferInsert)[] = [];
            for (const event of input.events) {
              pending.push({
                id: newId('evt'),
                organizationId: orgId,
                runId: input.runId,
                sequence: await nextEventSequence(tx, input.runId),
                projectId: input.projectId,
                phaseId: event.phaseId ?? null,
                taskId: event.taskId ?? null,
                agentId: event.agentId ?? null,
                type: event.type,
                visibility: event.visibility,
                payloadJson: event.payload,
                occurredAt: new Date(event.occurredAt),
              });
            }
            const inserted = await tx.insert(agentEvents).values(pending).returning();
            await tx.execute(sql`select pg_notify('agent_events', ${input.runId})`);
            await input.audit(tx, inserted);
            return { kind: 'stored', events: inserted };
          });
        },
      },

      auditEvents: {
        async list(request: AuditEventListRequest): Promise<StorePage<AuditEvent>> {
          const rows = await db
            .select()
            .from(auditEvents)
            .where(
              scoped(
                auditEvents.organizationId,
                ...(request.cursor === undefined ? [] : [lt(auditEvents.id, request.cursor)]),
                ...(request.actorId === undefined ? [] : [eq(auditEvents.actorId, request.actorId)]),
                ...(request.action === undefined ? [] : [eq(auditEvents.action, request.action)]),
                ...(request.targetType === undefined ? [] : [eq(auditEvents.targetType, request.targetType)]),
                ...(request.targetId === undefined ? [] : [eq(auditEvents.targetId, request.targetId)]),
                ...(request.from === undefined ? [] : [gte(auditEvents.occurredAt, request.from)]),
                ...(request.to === undefined ? [] : [lte(auditEvents.occurredAt, request.to)]),
              ),
            )
            .orderBy(desc(auditEvents.id))
            .limit(request.limit + 1);
          const items = rows.slice(0, request.limit);
          return {
            items,
            nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
          };
        },
      },

      projects: {
        ...base.projects,

        async list(request: ProjectListRequest): Promise<StorePage<Project>> {
          const rows = await db
            .select()
            .from(projects)
            .where(
              scoped(
                projects.organizationId,
                ...(request.cursor === undefined ? [] : [lt(projects.id, request.cursor)]),
                ...(request.includeArchived === true ? [] : [isNull(projects.archivedAt)]),
              ),
            )
            // Ids are monotonic ULIDs, so descending id is newest-first — and a
            // total order, which is what makes the cursor unambiguous.
            .orderBy(desc(projects.id))
            // One extra row, never returned: its presence is the whole of "there
            // is another page", and asking that way costs one row, not a count.
            .limit(request.limit + 1);

          const items = rows.slice(0, request.limit);
          return {
            items,
            nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
          };
        },

        async create(input: NewProjectInput): Promise<CreatedProject> {
          try {
            return await db.transaction(async (tx) => {
              const [project] = await tx
                .insert(projects)
                .values({
                  id: newId('proj'),
                  // The handle's organization, full stop. There is deliberately
                  // no way for a caller to supply this.
                  organizationId: orgId,
                  name: input.name,
                  slug: input.slug,
                  description: input.description,
                  sourceType: input.sourceType,
                  supportLevel: input.supportLevel,
                  createdBy: input.createdBy,
                  createdAt: input.now,
                })
                .returning();
              if (project === undefined) {
                // Unreachable: an insert with RETURNING yields the row it wrote.
                throw new Error('project insert returned no row');
              }

              // Ordered deliberately: the slug collision is settled by the
              // insert above before anything is asked of the git service, so a
              // retry with a suffixed slug never leaves a repository behind.
              const { internalRepoRef, provisionedAt } = await input.repository({
                project,
                defaultBranch: DEFAULT_BRANCH,
              });

              const [repository] = await tx
                .insert(repositories)
                .values({
                  id: newId('repo'),
                  organizationId: orgId,
                  projectId: project.id,
                  provider: INTERNAL_PROVIDER,
                  internalRepoRef,
                  externalRepoRef: null,
                  defaultBranch: DEFAULT_BRANCH,
                  syncPolicy: NO_SYNC,
                  /**
                   * Null when the git service only *named* the repository, set
                   * when it created one (plan 06 GIT-2). The column is the one
                   * thing that distinguishes a row still to be provisioned from
                   * one that must not be created twice
                   * (`packages/db/src/schema/projects.ts`), so it is written
                   * from what the implementation reported rather than from the
                   * fact that this insert ran.
                   */
                  provisionedAt: provisionedAt ?? null,
                })
                .returning();
              if (repository === undefined) {
                throw new Error('repository insert returned no row');
              }

              const [branch] = await tx
                .insert(branches)
                .values({
                  id: newId('br'),
                  organizationId: orgId,
                  projectId: project.id,
                  name: DEFAULT_BRANCH,
                  // Unborn until the first commit lands, which is the workspace
                  // service's to report (plan 03).
                  headCommitSha: null,
                  // Null for the default branch: it was cut from nothing.
                  baseBranchId: null,
                  status: BRANCH_ACTIVE,
                })
                .returning();
              if (branch === undefined) {
                throw new Error('branch insert returned no row');
              }

              const created = await tx
                .insert(environments)
                .values(
                  DEFAULT_ENVIRONMENTS.map((name) => ({
                    id: newId('env'),
                    organizationId: orgId,
                    projectId: project.id,
                    name,
                    // Name and type coincide for the two a project starts with;
                    // plan 07 adds environments where they do not.
                    type: name,
                    deploymentProvider: null,
                    databaseConnectionId: null,
                    createdAt: input.now,
                  })),
                )
                .returning();

              const resources: ProjectResources = {
                project,
                repository,
                branches: [branch],
                environments: created,
              };
              await input.audit(tx, resources);
              return resources;
            });
          } catch (error) {
            // The slug index, and nothing else. Creating a project also writes a
            // repository, a branch and two environments, each with unique
            // indexes of its own; reporting any of those as `slug_taken` sends
            // the retry loop above off to suffix a slug that was never the
            // problem (plan 02 CP-6 review).
            if (isUniqueViolation(error, PROJECT_SLUG_CONSTRAINT)) {
              return 'slug_taken';
            }
            throw error;
          }
        },

        async update(input: UpdateProjectInput): Promise<UpdatedProject> {
          const { patch } = input;
          try {
            return await db.transaction(async (tx) => {
              const [row] = await tx
                .update(projects)
                .set({
                  ...(patch.name === undefined ? {} : { name: patch.name }),
                  ...(patch.slug === undefined ? {} : { slug: patch.slug }),
                  ...(patch.description === undefined ? {} : { description: patch.description }),
                  ...(patch.archived === undefined
                    ? {}
                    : { archivedAt: patch.archived ? input.now : null }),
                })
                // The tenant predicate is part of the write's own WHERE, so
                // another tenant's project matches nothing and the answer is
                // "no such project" — the same answer as for one that never
                // existed.
                .where(scoped(projects.organizationId, eq(projects.id, input.projectId)))
                .returning();
              if (row !== undefined) {
                await input.audit(tx, row);
              }
              return row;
            });
          } catch (error) {
            if (isUniqueViolation(error, PROJECT_SLUG_CONSTRAINT)) {
              return 'slug_taken';
            }
            throw error;
          }
        },
      },

      specifications: {
        async getByProjectVersion(projectId, version) {
          const [row] = await db
            .select()
            .from(specifications)
            .where(
              scoped(
                specifications.organizationId,
                eq(specifications.projectId, projectId),
                eq(specifications.version, version),
              ),
            )
            .limit(1);
          return row;
        },

        async getForProject(projectId, specificationId) {
          const [row] = await db
            .select()
            .from(specifications)
            .where(
              scoped(
                specifications.organizationId,
                eq(specifications.projectId, projectId),
                eq(specifications.id, specificationId),
              ),
            )
            .limit(1);
          return row;
        },

        async create(input) {
          return await db.transaction(async (tx) => {
            // A no-op update is the row lock. It serializes distinct creates for
            // this project, so MAX(version) + 1 cannot race the unique index.
            const [project] = await tx
              .update(projects)
              .set({ archivedAt: sql`${projects.archivedAt}` })
              .where(scoped(projects.organizationId, eq(projects.id, input.projectId)))
              .returning({ id: projects.id });
            if (project === undefined) throw new Error('specification project disappeared during create');

            // The id is deterministic from the request's scoped idempotency
            // operation. Redis can lose its completed response after commit;
            // the durable row is the recovery record in that case.
            const [existing] = await tx
              .select()
              .from(specifications)
              .where(scoped(specifications.organizationId, eq(specifications.id, input.id)))
              .limit(1);
            if (existing !== undefined) return existing;

            const [latest] = await tx
              .select({ version: specifications.version })
              .from(specifications)
              .where(scoped(specifications.organizationId, eq(specifications.projectId, input.projectId)))
              .orderBy(desc(specifications.version))
              .limit(1);
            const [created] = await tx
              .insert(specifications)
              .values({
                id: input.id,
                organizationId: orgId,
                projectId: input.projectId,
                version: (latest?.version ?? 0) + 1,
                status: 'draft',
                contentJson: input.content,
                createdBy: input.createdBy,
                approvedBy: null,
                approvedAt: null,
              })
              .returning();
            if (created === undefined) throw new Error('specification insert returned no row');
            await input.audit(tx, created);
            return created;
          });
        },

        async update(input) {
          return await db.transaction(async (tx) => {
            // Lock before deciding mutability: an approval concurrent with this
            // request wins deterministically, and a post-approval PATCH never
            // writes over its immutable content.
            const [locked] = await tx
              .update(specifications)
              .set({ status: sql`${specifications.status}` })
              .where(
                scoped(
                  specifications.organizationId,
                  eq(specifications.projectId, input.projectId),
                  eq(specifications.version, input.version),
                ),
              )
              .returning();
            if (locked === undefined) return undefined;
            // An idempotency completion can fail after this transaction has
            // committed. Look up the operation's durable audit record across
            // this specification's complete history, not just the newest
            // event: another completed PATCH must not let a stale retry write
            // older content back over it.
            const [completedOperation] = await tx
              .select({ id: auditEvents.id })
              .from(auditEvents)
              .where(
                scoped(
                  auditEvents.organizationId,
                  eq(auditEvents.targetType, 'specification'),
                  eq(auditEvents.targetId, locked.id),
                  sql`${auditEvents.metadataJson} ->> 'operationKey' = ${input.operationKey}`,
                ),
              )
              .limit(1);
            if (completedOperation !== undefined) return locked;
            if (locked.status !== 'draft') return 'immutable';
            const [updated] = await tx
              .update(specifications)
              .set({ contentJson: input.content })
              .where(scoped(specifications.organizationId, eq(specifications.id, locked.id)))
              .returning();
            if (updated === undefined) throw new Error('locked specification disappeared during update');
            await input.audit(tx, updated);
            return updated;
          });
        },

        async approve(input) {
          return await db.transaction(async (tx) => {
            const [locked] = await tx
              .update(specifications)
              .set({ status: sql`${specifications.status}` })
              .where(
                scoped(
                  specifications.organizationId,
                  eq(specifications.projectId, input.projectId),
                  eq(specifications.version, input.version),
                ),
              )
              .returning();
            if (locked === undefined) return undefined;
            if (locked.status === 'approved') return locked;
            const [approved] = await tx
              .update(specifications)
              .set({ status: 'approved', approvedBy: input.approvedBy, approvedAt: input.approvedAt })
              .where(scoped(specifications.organizationId, eq(specifications.id, locked.id)))
              .returning();
            if (approved === undefined) throw new Error('locked specification disappeared during approval');
            await input.audit(tx, approved);
            return approved;
          });
        },
      },

      runs: {
        ...base.runs,

        async create(input: NewRunInput): Promise<AgentRun> {
          return await db.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(agentRuns)
              .values({
                id: input.id,
                organizationId: orgId,
                projectId: input.projectId,
                branchId: input.branchId,
                mode: input.mode,
                status: 'queued',
                specificationId: null,
                // The stable workflow identity is durable before dispatch. A
                // failed response can therefore resume the exact same intent.
                temporalWorkflowId: input.workflowId,
                startedBy: input.startedBy,
                budgetJson: input.budget,
                startedAt: input.now,
                completedAt: null,
              })
              .onConflictDoNothing()
              .returning();
            if (inserted !== undefined) {
              await input.audit(tx, inserted);
              return inserted;
            }
            const [run] = await tx
              .select()
              .from(agentRuns)
              .where(scoped(agentRuns.organizationId, eq(agentRuns.id, input.id)))
              .limit(1);
            if (run === undefined)
              throw new Error('run intent was not found after insert conflict');
            return run;
          });
        },

        async claimOperation(
          input: ClaimRunOperationInput,
        ): Promise<OperationClaim<AgentRun> | undefined> {
          return await db.transaction(async (tx) => {
            // A no-op write locks the row. It serializes the legal-state check
            // and the append-only requested audit intent without inventing a
            // state not approved by PRD §23.
            const [run] = await tx
              .update(agentRuns)
              .set({ status: sql`${agentRuns.status}` })
              .where(scoped(agentRuns.organizationId, eq(agentRuns.id, input.runId)))
              .returning();
            if (run === undefined) return undefined;
            const [latest] = await tx
              .select({ metadata: auditEvents.metadataJson })
              .from(auditEvents)
              .where(scoped(auditEvents.organizationId, eq(auditEvents.targetId, run.id)))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(1);
            const operation = durableOperation(latest?.metadata);
            if (operation?.state === 'requested') {
              return {
                entity: run,
                outcome: operation.key === input.operationKey ? 'dispatch' : 'blocked',
              };
            }
            if (operation?.key === input.operationKey) {
              return { entity: run, outcome: operation.state, metadata: operation.metadata };
            }
            if (!input.allowedStatuses.includes(run.status)) {
              return { entity: run, outcome: 'blocked' };
            }
            await input.audit(tx, run);
            return { entity: run, outcome: 'dispatch' };
          });
        },

        async completeOperation(input: CompleteRunOperationInput): Promise<AgentRun | undefined> {
          return await db.transaction(async (tx) => {
            const [locked] = await tx
              .update(agentRuns)
              .set({ status: sql`${agentRuns.status}` })
              .where(scoped(agentRuns.organizationId, eq(agentRuns.id, input.runId)))
              .returning();
            if (locked === undefined) return undefined;
            const [latest] = await tx
              .select({ metadata: auditEvents.metadataJson })
              .from(auditEvents)
              .where(scoped(auditEvents.organizationId, eq(auditEvents.targetId, locked.id)))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(1);
            const operation = durableOperation(latest?.metadata);
            if (operation?.key !== input.operationKey || operation.state !== 'requested')
              return undefined;
            const [run] = await tx
              .update(agentRuns)
              .set({ status: input.status, completedAt: input.completedAt })
              .where(
                scoped(
                  agentRuns.organizationId,
                  eq(agentRuns.id, input.runId),
                  eq(agentRuns.status, input.expectedStatus),
                ),
              )
              .returning();
            if (run !== undefined) {
              await input.audit(tx, run);
            }
            return run;
          });
        },

        async rejectOperation(input): Promise<AgentRun | undefined> {
          return await db.transaction(async (tx) => {
            const [run] = await tx
              .update(agentRuns)
              .set({ status: sql`${agentRuns.status}` })
              .where(scoped(agentRuns.organizationId, eq(agentRuns.id, input.runId)))
              .returning();
            if (run === undefined) return undefined;
            const [latest] = await tx
              .select({ metadata: auditEvents.metadataJson })
              .from(auditEvents)
              .where(scoped(auditEvents.organizationId, eq(auditEvents.targetId, run.id)))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(1);
            const operation = durableOperation(latest?.metadata);
            if (operation?.key !== input.operationKey || operation.state !== 'requested')
              return undefined;
            await input.audit(tx, run);
            return run;
          });
        },
      },

      workspaces: {
        async getById(id) {
          const [row] = await db
            .select()
            .from(workspaces)
            .where(scoped(workspaces.organizationId, eq(workspaces.id, id)))
            .limit(1);
          return row;
        },
        async create(input) {
          return await db.transaction(async (tx) => {
            const provisional: Workspace = {
              id: input.id,
              organizationId: orgId,
              projectId: input.projectId,
              branchId: input.branchId,
              provider: 'modal',
              providerWorkspaceId: null,
              status: 'requested',
              resourceProfile: input.resourceProfile,
              snapshotRef: null,
              createdAt: input.now,
              lastActiveAt: null,
              terminatedAt: null,
            };
            const [inserted] = await tx
              .insert(workspaces)
              .values(provisional)
              .onConflictDoNothing()
              .returning();
            if (inserted !== undefined) {
              await input.audit(tx, inserted);
              return inserted;
            }
            const [row] = await tx
              .select()
              .from(workspaces)
              .where(scoped(workspaces.organizationId, eq(workspaces.id, input.id)))
              .limit(1);
            if (row === undefined)
              throw new Error('workspace intent was not found after insert conflict');
            return row;
          });
        },
        async completeCreate(input) {
          return await db.transaction(async (tx) => {
            const [row] = await tx
              .update(workspaces)
              .set({
                providerWorkspaceId: input.providerWorkspaceId,
                status: input.status,
              })
              .where(
                scoped(
                  workspaces.organizationId,
                  eq(workspaces.id, input.workspaceId),
                  isNull(workspaces.providerWorkspaceId),
                  eq(workspaces.status, 'requested'),
                ),
              )
              .returning();
            if (row !== undefined) await input.audit(tx, row);
            return row;
          });
        },
        async claimOperation(input) {
          return await db.transaction(async (tx) => {
            const [workspace] = await tx
              .update(workspaces)
              .set({ lastActiveAt: sql`${workspaces.lastActiveAt}` })
              .where(scoped(workspaces.organizationId, eq(workspaces.id, input.workspaceId)))
              .returning();
            if (workspace === undefined) return undefined;
            const [latest] = await tx
              .select({ metadata: auditEvents.metadataJson })
              .from(auditEvents)
              .where(scoped(auditEvents.organizationId, eq(auditEvents.targetId, workspace.id)))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(1);
            const operation = durableOperation(latest?.metadata);
            if (operation?.state === 'requested') {
              return {
                entity: workspace,
                outcome: operation.key === input.operationKey ? 'dispatch' : 'blocked',
              };
            }
            if (operation?.key === input.operationKey) {
              return { entity: workspace, outcome: operation.state, metadata: operation.metadata };
            }
            if (!input.allowedStatuses.includes(workspace.status)) {
              return { entity: workspace, outcome: 'blocked' };
            }
            await input.audit(tx, workspace);
            return { entity: workspace, outcome: 'dispatch' };
          });
        },
        async completeOperation(input) {
          return await db.transaction(async (tx) => {
            const [locked] = await tx
              .update(workspaces)
              .set({ lastActiveAt: sql`${workspaces.lastActiveAt}` })
              .where(scoped(workspaces.organizationId, eq(workspaces.id, input.workspaceId)))
              .returning();
            if (locked === undefined) return undefined;
            const [latest] = await tx
              .select({ metadata: auditEvents.metadataJson })
              .from(auditEvents)
              .where(scoped(auditEvents.organizationId, eq(auditEvents.targetId, locked.id)))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(1);
            const operation = durableOperation(latest?.metadata);
            if (operation?.key !== input.operationKey || operation.state !== 'requested')
              return undefined;
            const [row] = await tx
              .update(workspaces)
              .set({
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.snapshotRef === undefined ? {} : { snapshotRef: input.snapshotRef }),
                ...(input.terminatedAt === undefined ? {} : { terminatedAt: input.terminatedAt }),
                lastActiveAt: input.now,
              })
              .where(
                scoped(
                  workspaces.organizationId,
                  eq(workspaces.id, input.workspaceId),
                  eq(workspaces.status, input.expectedStatus),
                ),
              )
              .returning();
            if (row !== undefined) await input.audit(tx, row);
            return row;
          });
        },
        async rejectOperation(input) {
          return await db.transaction(async (tx) => {
            const [workspace] = await tx
              .update(workspaces)
              .set({ lastActiveAt: sql`${workspaces.lastActiveAt}` })
              .where(scoped(workspaces.organizationId, eq(workspaces.id, input.workspaceId)))
              .returning();
            if (workspace === undefined) return undefined;
            const [latest] = await tx
              .select({ metadata: auditEvents.metadataJson })
              .from(auditEvents)
              .where(scoped(auditEvents.organizationId, eq(auditEvents.targetId, workspace.id)))
              .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
              .limit(1);
            const operation = durableOperation(latest?.metadata);
            if (operation?.key !== input.operationKey || operation.state !== 'requested')
              return undefined;
            await input.audit(tx, workspace);
            return workspace;
          });
        },
      },

      repositories: {
        async forProject(projectId: string): Promise<Repository | undefined> {
          const [row] = await db
            .select()
            .from(repositories)
            .where(scoped(repositories.organizationId, eq(repositories.projectId, projectId)))
            .limit(1);
          return row;
        },
      },

      branches: {
        async byProject(projectId: string): Promise<Branch[]> {
          return await db
            .select()
            .from(branches)
            .where(scoped(branches.organizationId, eq(branches.projectId, projectId)))
            .orderBy(desc(branches.id));
        },
        async getForProject(projectId: string, branchId: string): Promise<Branch | undefined> {
          const [row] = await db
            .select()
            .from(branches)
            .where(
              scoped(
                branches.organizationId,
                eq(branches.projectId, projectId),
                eq(branches.id, branchId),
              ),
            )
            .limit(1);
          return row;
        },
      },

      environments: {
        async byProject(projectId: string): Promise<Environment[]> {
          return await db
            .select()
            .from(environments)
            .where(scoped(environments.organizationId, eq(environments.projectId, projectId)))
            // Ascending: `preview` then `production`, in the order they were
            // created, which is the order a client renders them in.
            .orderBy(asc(environments.id));
        },
        async getForProject(projectId: string, environmentId: string): Promise<Environment | undefined> {
          const [row] = await db
            .select()
            .from(environments)
            .where(
              scoped(
                environments.organizationId,
                eq(environments.projectId, projectId),
                eq(environments.id, environmentId),
              ),
            )
            .limit(1);
          return row;
        },
      },

      secrets: {
        async list(request: SecretListRequest): Promise<StorePage<SecretMetadata>> {
          // The metadata-only guarantee is the *table*, not this projection.
          // `select()` here is `select *` over `secret_metadata` — which has no
          // ciphertext column to widen into, because the envelope lives on
          // `secret_ciphertexts` and this statement names neither it nor a join
          // to it (`packages/db/src/schema/security.ts`). The one column that
          // even points at the vault, `encrypted_value_ref`, is a pointer rather
          // than key material, and the route's response schema drops it on the
          // way out (`src/routes/secrets.ts`).
          //
          // What that leaves for a later schema change: a sensitive column
          // added to `secret_metadata` would be selected here. The guard is
          // that adding one is a migration against a table whose whole purpose
          // is to hold what a value is *not*, and `test/secrets.test.ts` asserts
          // recursively that no response body contains a plaintext.
          const rows = await db
            .select()
            .from(secretMetadata)
            .where(
              scoped(
                secretMetadata.organizationId,
                eq(secretMetadata.projectId, request.projectId),
                ...(request.cursor === undefined ? [] : [lt(secretMetadata.id, request.cursor)]),
              ),
            )
            .orderBy(desc(secretMetadata.id))
            .limit(request.limit + 1);

          const items = rows.slice(0, request.limit);
          return {
            items,
            nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
          };
        },

        async getById(secretId: string): Promise<SecretMetadata | undefined> {
          const [row] = await db
            .select()
            .from(secretMetadata)
            .where(scoped(secretMetadata.organizationId, eq(secretMetadata.id, secretId)))
            .limit(1);
          return row;
        },

        async create(input: NewSecretInput): Promise<CreatedSecret> {
          const id = newId('sec');
          try {
            return await db.transaction(async (tx) => {
              const [secret] = await tx
                .insert(secretMetadata)
                .values({
                  id,
                  // The handle's organization, like every other write here.
                  organizationId: orgId,
                  projectId: input.projectId,
                  environmentId: input.environmentId,
                  name: input.name,
                  /**
                   * Where the ciphertext is, in a form that says which vault:
                   * PostgreSQL today, a KMS-fronted store later. Derivable from
                   * the id, and written down anyway — the day some rows move,
                   * this column is what says which ones have.
                   */
                  encryptedValueRef: vaultRef(id),
                  createdBy: input.createdBy,
                  rotatedAt: null,
                  keyVersion: input.envelope.keyVersion,
                  createdAt: input.now,
                })
                .returning();
              if (secret === undefined) {
                throw new Error('secret insert returned no row');
              }

              await tx.insert(secretCiphertexts).values({
                secretId: secret.id,
                ciphertext: input.envelope.ciphertext,
                iv: input.envelope.iv,
                authTag: input.envelope.authTag,
                wrappedDek: input.envelope.wrappedDek,
              });

              await input.audit(tx, secret);
              return secret;
            });
          } catch (error) {
            // Only the name indexes: a violation of anything else here is a bug
            // to surface, not a conflict to report as one (see `db/errors.ts`).
            if (isUniqueViolation(error, SECRET_NAME_CONSTRAINTS)) {
              return 'name_taken';
            }
            throw error;
          }
        },

        async rotate(input: RotateSecretInput): Promise<SecretMetadata | undefined> {
          return await db.transaction(async (tx) => {
            const [secret] = await tx
              .update(secretMetadata)
              .set({ rotatedAt: input.now, keyVersion: input.envelope.keyVersion })
              // The tenant predicate is part of the write's own WHERE, so
              // another tenant's secret matches nothing.
              .where(scoped(secretMetadata.organizationId, eq(secretMetadata.id, input.secretId)))
              .returning();
            if (secret === undefined) {
              return undefined;
            }

            /**
             * Overwritten, not versioned. P0 keeps no history (plan 02 CP-7):
             * the previous value is unrecoverable the moment this commits, which
             * is what "rotated" has to mean — a vault that can still produce the
             * credential you rotated away from has not rotated anything. A
             * future task that wants history adds rows to
             * `secret_ciphertexts` with a version column; nothing here assumes
             * one row per secret except this statement.
             */
            await tx
              .update(secretCiphertexts)
              .set({
                ciphertext: input.envelope.ciphertext,
                iv: input.envelope.iv,
                authTag: input.envelope.authTag,
                wrappedDek: input.envelope.wrappedDek,
              })
              .where(eq(secretCiphertexts.secretId, secret.id));

            await input.audit(tx, secret);
            return secret;
          });
        },

        async delete(input: DeleteSecretInput): Promise<SecretMetadata | undefined> {
          return await db.transaction(async (tx) => {
            // The ciphertext goes with it: `secret_ciphertexts.secret_id` is
            // ON DELETE CASCADE, so there is no order of statements here that
            // leaves an orphaned encrypted value behind.
            const [secret] = await tx
              .delete(secretMetadata)
              .where(scoped(secretMetadata.organizationId, eq(secretMetadata.id, input.secretId)))
              .returning();
            if (secret === undefined) {
              return undefined;
            }
            await input.audit(tx, secret);
            return secret;
          });
        },

        async readEnvelope(input: ReadSecretInput): Promise<StoredSecret | undefined> {
          return await db.transaction(async (tx) => {
            const [row] = await tx
              .select({ secret: secretMetadata, ciphertext: secretCiphertexts })
              .from(secretMetadata)
              .innerJoin(secretCiphertexts, eq(secretCiphertexts.secretId, secretMetadata.id))
              // The join is reached *from* the tenant-scoped side and the
              // predicate is on this table's own column, so a secret that is
              // not this handle's organization's matches nothing — the vault
              // row is never the entry point.
              .where(scoped(secretMetadata.organizationId, eq(secretMetadata.id, input.secretId)))
              .limit(1);
            if (row === undefined) {
              return undefined;
            }

            /**
             * Before the return, inside the transaction that read it: the row
             * saying key material was released and the release itself commit
             * together or not at all. An audit hook that throws takes the read
             * with it, and the caller gets an error rather than a value nobody
             * recorded.
             */
            await input.audit(tx, row.secret);

            return {
              secret: row.secret,
              envelope: {
                ciphertext: row.ciphertext.ciphertext,
                iv: row.ciphertext.iv,
                authTag: row.ciphertext.authTag,
                wrappedDek: row.ciphertext.wrappedDek,
                keyVersion: row.secret.keyVersion,
              },
            };
          });
        },
      },

      contracts: {
        async latestForProject(projectId: string): Promise<ProjectContract | undefined> {
          const [row] = await db
            .select()
            .from(projectContracts)
            .where(
              scoped(projectContracts.organizationId, eq(projectContracts.projectId, projectId)),
            )
            .orderBy(desc(projectContracts.version))
            .limit(1);
          return row;
        },
      },
    };
  };
}
