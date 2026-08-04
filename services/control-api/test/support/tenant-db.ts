import { newId } from '@zapp/contracts';
import type {
  AgentEventRow,
  AgentRun,
  Branch,
  Environment,
  Project,
  ProjectContract,
  Repository,
} from '@zapp/db';

import { NO_TRANSACTION } from '../../src/plugins/audit.js';
import type { StorePage } from '../../src/pagination.js';
import type {
  CreatedProject,
  NewProjectInput,
  TenantDatabase,
  TenantDbFactory,
  UpdateProjectInput,
  UpdatedProject,
} from '../../src/tenant/db.js';
import {
  BRANCH_ACTIVE,
  DEFAULT_BRANCH,
  DEFAULT_ENVIRONMENTS,
  INTERNAL_PROVIDER,
  NO_SYNC,
} from '../../src/tenant/vocabulary.js';

/**
 * The tenant handle, in memory, for the route suites.
 *
 * It is a double for PostgreSQL, not for the isolation rules: every method here
 * filters by `organizationId` exactly as `forOrg` and `src/tenant/db.ts` do, so
 * a route that leaks across tenants leaks here too. What it cannot prove is that
 * the *SQL* is scoped — `test/integration/tenant-isolation.test.ts` is what does
 * that, against a real database, and it is the milestone gate.
 *
 * Two behaviours are modelled deliberately rather than approximated:
 *
 *   - **Creation is all-or-nothing.** Every row is built into locals and pushed
 *     into the store only after the repository callback and the audit hook have
 *     both returned. A callback that throws leaves nothing behind, which is what
 *     a rolled-back transaction looks like from the outside — and lets the route
 *     suite assert the rollback without a database.
 *   - **The slug is unique per organization.** Two tenants may both own
 *     `checkout`; the same tenant may not own it twice. A global check here
 *     would let a route pass this suite and then leak the existence of another
 *     tenant's project in production.
 */

/** Rows shared by every handle the factory hands out, as one database would be. */
export class InMemoryTenantData {
  readonly projects: Project[] = [];
  readonly repositories: Repository[] = [];
  readonly branches: Branch[] = [];
  readonly environments: Environment[] = [];
  readonly contracts: ProjectContract[] = [];
  readonly runs: AgentRun[] = [];
  readonly events: AgentEventRow[] = [];

  /** Every handle reads and writes the same rows — see the class comment. */
  readonly factory: TenantDbFactory = (organizationId: string): TenantDatabase =>
    handleFor(this, organizationId);

  /** Seeds a contract for a project, as plan 05's scan pipeline eventually will. */
  addContract(project: Project, contract: Partial<ProjectContract> = {}): ProjectContract {
    const row: ProjectContract = {
      id: newId('pc'),
      organizationId: project.organizationId,
      projectId: project.id,
      version: 1,
      detectedFramework: 'next',
      contractJson: { version: 1, package_manager: 'pnpm' },
      createdAt: new Date('2026-08-15T12:00:00.000Z'),
      ...contract,
    };
    this.contracts.push(row);
    return row;
  }
}

/**
 * The tenant predicate, and the only way a query in this file selects rows —
 * the in-memory equivalent of `organization_id = <the tenant>` in a WHERE
 * clause. A method that filtered by anything else would be a double that is
 * more permissive than the thing it doubles.
 */
function mine<T extends { organizationId: string }>(organizationId: string, rows: T[]): T[] {
  return rows.filter((row) => row.organizationId === organizationId);
}

/** One organization's view of `data`. A free function, so nothing aliases `this`. */
function handleFor(data: InMemoryTenantData, orgId: string): TenantDatabase {
  return {
    organizationId: orgId,

    projects: {
      list(request): Promise<StorePage<Project>> {
        const rows = mine(orgId, data.projects)
          .filter((project) => request.includeArchived === true || project.archivedAt === null)
          .filter((project) => request.cursor === undefined || project.id < request.cursor)
          // Descending id: monotonic ULIDs make that newest-first and a total
          // order, which is what makes the cursor unambiguous.
          .sort((left, right) => (left.id < right.id ? 1 : -1));

        const items = rows.slice(0, request.limit);
        return Promise.resolve({
          items,
          nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
        });
      },

      getById(projectId): Promise<Project | undefined> {
        return Promise.resolve(
          mine(orgId, data.projects).find((project) => project.id === projectId),
        );
      },

      async create(input: NewProjectInput): Promise<CreatedProject> {
        const taken = mine(orgId, data.projects).some((project) => project.slug === input.slug);
        if (taken) {
          return 'slug_taken';
        }

        const project: Project = {
          id: newId('proj'),
          organizationId: orgId,
          name: input.name,
          slug: input.slug,
          description: input.description,
          sourceType: input.sourceType,
          supportLevel: input.supportLevel,
          createdBy: input.createdBy,
          createdAt: input.now,
          archivedAt: null,
        };

        // Outside the store until everything below succeeds: this is the
        // transaction boundary, modelled.
        const { internalRepoRef } = await input.repository({
          project,
          defaultBranch: DEFAULT_BRANCH,
        });

        const repository: Repository = {
          id: newId('repo'),
          organizationId: orgId,
          projectId: project.id,
          provider: INTERNAL_PROVIDER,
          internalRepoRef,
          externalRepoRef: null,
          defaultBranch: DEFAULT_BRANCH,
          syncPolicy: NO_SYNC,
        };
        const branch: Branch = {
          id: newId('br'),
          organizationId: orgId,
          projectId: project.id,
          name: DEFAULT_BRANCH,
          headCommitSha: null,
          baseBranchId: null,
          status: BRANCH_ACTIVE,
        };
        const created: Environment[] = DEFAULT_ENVIRONMENTS.map((name) => ({
          id: newId('env'),
          organizationId: orgId,
          projectId: project.id,
          name,
          type: name,
          deploymentProvider: null,
          databaseConnectionId: null,
          createdAt: input.now,
        }));

        const resources = { project, repository, branches: [branch], environments: created };
        await input.audit(NO_TRANSACTION, resources);

        data.projects.push(project);
        data.repositories.push(repository);
        data.branches.push(branch);
        data.environments.push(...created);
        return resources;
      },

      async update(input: UpdateProjectInput): Promise<UpdatedProject> {
        const existing = mine(orgId, data.projects).find(
          (project) => project.id === input.projectId,
        );
        if (existing === undefined) {
          return undefined;
        }
        const { patch } = input;
        if (
          patch.slug !== undefined &&
          mine(orgId, data.projects).some(
            (project) => project.slug === patch.slug && project.id !== existing.id,
          )
        ) {
          return 'slug_taken';
        }

        const updated: Project = {
          ...existing,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.slug === undefined ? {} : { slug: patch.slug }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.archived === undefined
            ? {}
            : { archivedAt: patch.archived ? input.now : null }),
        };
        await input.audit(NO_TRANSACTION, updated);
        data.projects.splice(data.projects.indexOf(existing), 1, updated);
        return updated;
      },
    },

    repositories: {
      forProject(projectId): Promise<Repository | undefined> {
        return Promise.resolve(
          mine(orgId, data.repositories).find((row) => row.projectId === projectId),
        );
      },
    },

    branches: {
      byProject(projectId): Promise<Branch[]> {
        return Promise.resolve(
          mine(orgId, data.branches).filter((row) => row.projectId === projectId),
        );
      },
    },

    environments: {
      byProject(projectId): Promise<Environment[]> {
        return Promise.resolve(
          mine(orgId, data.environments).filter((row) => row.projectId === projectId),
        );
      },
    },

    contracts: {
      latestForProject(projectId): Promise<ProjectContract | undefined> {
        const rows = mine(orgId, data.contracts)
          .filter((row) => row.projectId === projectId)
          .sort((left, right) => right.version - left.version);
        return Promise.resolve(rows[0]);
      },
    },

    runs: {
      byProject(projectId): Promise<AgentRun[]> {
        return Promise.resolve(mine(orgId, data.runs).filter((row) => row.projectId === projectId));
      },
      getById(runId): Promise<AgentRun | undefined> {
        return Promise.resolve(mine(orgId, data.runs).find((row) => row.id === runId));
      },
    },

    events: {
      byRun(runId): Promise<AgentEventRow[]> {
        return Promise.resolve(mine(orgId, data.events).filter((row) => row.runId === runId));
      },
    },
  };
}
