import { idSchema } from '@zapp/contracts';
import { and, asc, desc, eq, gte, lte, type SQL } from 'drizzle-orm';

import type { Database } from './client.js';
import { agentEvents, type AgentEventRow } from './schema/execution.js';
import { agentRuns, type AgentRun } from './schema/planning.js';
import { projects, type Project } from './schema/projects.js';

/**
 * Tenant-scoped reads (PRD §22.3, plan 01 FND-6).
 *
 * Every query built here carries `organization_id = <the tenant>` in its own
 * WHERE clause — never inherited from a parent row, never inferred from a join.
 * A caller that holds a `TenantDb` cannot express a cross-tenant read: another
 * organization's project simply does not exist for it. That is deliberate, and
 * it is why these return empty results rather than throwing — turning "not
 * yours" into a 404 is the API layer's job (plan 02 CP-4), and doing it here
 * would leak the existence of the row.
 *
 * This is the read path. Writes stay explicit at the call site, because an
 * insert has to set `organization_id` rather than filter by it, and hiding that
 * would make it easy to write a row that no tenant query can ever see again.
 */

const organizationIdSchema = idSchema('org');

/** Sequence window for {@link EventRepository.byRun}; both bounds inclusive. */
export interface EventRange {
  /** First sequence to return. Plan 02's resumable stream (CP-15) passes `lastSeen + 1`. */
  readonly fromSequence?: number;
  readonly toSequence?: number;
  /** Caps the page. Left to the caller: `@zapp/contracts` owns pagination defaults (FND-10). */
  readonly limit?: number;
}

export interface ProjectRepository {
  /** The tenant's projects, newest first. Archived ones included — filtering them is policy (plan 02 CP-6). */
  list(): Promise<Project[]>;
  /** The project, or `undefined` when it belongs to another tenant or does not exist. */
  getById(projectId: string): Promise<Project | undefined>;
}

export interface RunRepository {
  /** The project's runs, newest first; empty when the project belongs to another tenant. */
  byProject(projectId: string): Promise<AgentRun[]>;
  getById(runId: string): Promise<AgentRun | undefined>;
}

export interface EventRepository {
  /** The run's events in sequence order; empty when the run belongs to another tenant. */
  byRun(runId: string, range?: EventRange): Promise<AgentEventRow[]>;
}

export interface TenantDb {
  readonly organizationId: string;
  readonly projects: ProjectRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
}

/**
 * Binds a database handle to one organization.
 *
 * The id is validated rather than trusted: this is the boundary the whole
 * isolation story rests on, and a caller passing a project id, an empty string
 * or a value straight off a request must fail here, loudly, instead of quietly
 * scoping every subsequent query to something that matches no rows.
 */
export function forOrg(db: Database, organizationId: string): TenantDb {
  const orgId = organizationIdSchema.parse(organizationId);

  return {
    organizationId: orgId,

    projects: {
      async list(): Promise<Project[]> {
        return await db
          .select()
          .from(projects)
          .where(eq(projects.organizationId, orgId))
          // Ids are monotonic ULIDs, so descending id is newest-first and
          // ties cannot happen — no second sort key needed for determinism.
          .orderBy(desc(projects.id));
      },

      async getById(projectId: string): Promise<Project | undefined> {
        const [project] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.organizationId, orgId), eq(projects.id, projectId)))
          .limit(1);
        return project;
      },
    },

    runs: {
      async byProject(projectId: string): Promise<AgentRun[]> {
        return await db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.organizationId, orgId), eq(agentRuns.projectId, projectId)))
          .orderBy(desc(agentRuns.id));
      },

      async getById(runId: string): Promise<AgentRun | undefined> {
        const [run] = await db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.organizationId, orgId), eq(agentRuns.id, runId)))
          .limit(1);
        return run;
      },
    },

    events: {
      async byRun(runId: string, range: EventRange = {}): Promise<AgentEventRow[]> {
        const filters: SQL[] = [
          eq(agentEvents.organizationId, orgId),
          eq(agentEvents.runId, runId),
        ];
        if (range.fromSequence !== undefined) {
          filters.push(gte(agentEvents.sequence, range.fromSequence));
        }
        if (range.toSequence !== undefined) {
          filters.push(lte(agentEvents.sequence, range.toSequence));
        }

        const query = db
          .select()
          .from(agentEvents)
          .where(and(...filters))
          // Sequence, not `occurred_at`: the sequence is what clients resume
          // from, and two events can share a timestamp (PRD §14.4).
          .orderBy(asc(agentEvents.sequence));

        return range.limit === undefined ? await query : await query.limit(range.limit);
      },
    },
  };
}
