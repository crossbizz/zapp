import { newId, type SupportLevel } from '@zapp/contracts';
import {
  branches,
  environments,
  forOrg,
  projectContracts,
  projects,
  repositories,
  type Branch,
  type Database,
  type Environment,
  type Project,
  type ProjectContract,
  type ProjectRepository,
  type Repository,
  type TenantDb,
} from '@zapp/db';
import { and, asc, desc, eq, isNull, lt, type Column, type SQL } from 'drizzle-orm';

import { isUniqueViolation } from '../db/errors.js';
import type { PageRequest, StorePage } from '../pagination.js';
import type { AuditHook } from '../plugins/audit.js';
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
  readonly repository: (request: RepositoryRequest) => Promise<{ internalRepoRef: string }>;
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
}

export interface TenantEnvironmentRepository {
  /** The project's environments, oldest first; empty for another tenant's project. */
  byProject(projectId: string): Promise<Environment[]>;
}

export interface TenantContractRepository {
  /**
   * The newest `project_contracts` row, or `undefined` when the project has
   * never been scanned. Versions are monotonic per project and a scan appends
   * one rather than overwriting (PRD §17.2), so "latest" is "highest version".
   */
  latestForProject(projectId: string): Promise<ProjectContract | undefined>;
}

/** `TenantDb` (plan 01's reads) plus the project lifecycle the control plane owns. */
export interface TenantDatabase extends Omit<TenantDb, 'projects'> {
  readonly projects: TenantProjectRepository;
  readonly repositories: TenantRepositoryRepository;
  readonly branches: TenantBranchRepository;
  readonly environments: TenantEnvironmentRepository;
  readonly contracts: TenantContractRepository;
}

/**
 * Binds a database handle to one organization. The plugin calls this once per
 * request, with an id it has already checked an active membership for.
 */
export type TenantDbFactory = (organizationId: string) => TenantDatabase;

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
              const { internalRepoRef } = await input.repository({
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
            if (isUniqueViolation(error)) {
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
            if (isUniqueViolation(error)) {
              return 'slug_taken';
            }
            throw error;
          }
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
