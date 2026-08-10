import { idSchema } from '@zapp/contracts';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from './client.js';
import type { AgentEventRow } from './schema/execution.js';
import { agentRuns, type AgentRun } from './schema/planning.js';
import {
  previewShares,
  projects,
  type PreviewShareRow,
  type Project,
} from './schema/projects.js';

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
  /** Cancels an in-flight driver query when a stream disconnects or the service shuts down. */
  readonly signal?: AbortSignal;
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

export interface PreviewShareRepository {
  getById(shareId: string): Promise<PreviewShareRow | undefined>;
  listByProject(projectId: string): Promise<PreviewShareRow[]>;
}

export interface TenantDb {
  readonly organizationId: string;
  readonly projects: ProjectRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly previewShares: PreviewShareRepository;
}

interface RawAgentEventRow {
  readonly id: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly sequence: string | number;
  readonly type: string;
  readonly payloadJson: unknown;
  readonly visibility: string;
  readonly occurredAt: Date | string;
  readonly projectId: string;
  readonly phaseId: string | null;
  readonly taskId: string | null;
  readonly agentId: string | null;
}

function aborted(): Error {
  const error = new Error('The event replay was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function reserveForReplay(db: Database, signal: AbortSignal | undefined) {
  const reservation = db.$client.reserve();
  if (signal === undefined) return await reservation;

  let rejectAbort!: (reason: Error) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort(aborted());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (isAborted(signal)) onAbort();

  try {
    return await Promise.race([reservation, abort]);
  } catch (error) {
    if (isAborted(signal)) {
      // postgres.js does not expose removal of a queued reservation. If the
      // pool hands it out after this caller has gone away, release it without
      // ever dispatching a statement on that connection.
      void reservation.then(
        (reserved) => {
          reserved.release();
        },
        () => undefined,
      );
      throw aborted();
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

interface ReplayCancellation {
  readonly settled: Promise<void>;
}

function settleQuery(query: PromiseLike<unknown>): Promise<void> {
  return Promise.resolve(query).then(
    () => undefined,
    () => undefined,
  );
}

/** Cancels through postgres.js's public query API and fences on query settlement. */
function cancelReplayQuery(query: PromiseLike<unknown> & { cancel(): void }): ReplayCancellation {
  try {
    query.cancel();
  } catch {
    // Settlement below still owns the reserved connection and fails closed.
  }
  return { settled: settleQuery(query) };
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
        if (isAborted(range.signal)) throw aborted();
        const parameters: (number | string)[] = [orgId, runId];
        const filters = ['organization_id = $1', 'run_id = $2'];
        if (range.fromSequence !== undefined) {
          parameters.push(range.fromSequence);
          filters.push(`sequence >= $${String(parameters.length)}`);
        }
        if (range.toSequence !== undefined) {
          parameters.push(range.toSequence);
          filters.push(`sequence <= $${String(parameters.length)}`);
        }
        const limit =
          range.limit === undefined
            ? ''
            : (() => {
                parameters.push(range.limit);
                return ` limit $${String(parameters.length)}`;
              })();
        const reserved = await reserveForReplay(db, range.signal);
        let cancellation: ReplayCancellation | undefined;
        try {
          if (isAborted(range.signal)) throw aborted();
          const pending = reserved.unsafe<RawAgentEventRow[]>(
            `select id,
                  organization_id as "organizationId",
                  run_id as "runId",
                  sequence,
                  type,
                  payload_json as "payloadJson",
                  visibility,
                  occurred_at as "occurredAt",
                  project_id as "projectId",
                  phase_id as "phaseId",
                  task_id as "taskId",
                  agent_id as "agentId"
             from agent_events
            where ${filters.join(' and ')}
            order by sequence asc${limit}`,
            parameters,
          );
          const cancel = (): void => {
            if (cancellation !== undefined) return;
            cancellation = cancelReplayQuery(pending);
          };
          range.signal?.addEventListener('abort', cancel, { once: true });
          void pending.execute();
          if (isAborted(range.signal)) cancel();
          try {
            const rows = await pending;
            if (isAborted(range.signal)) throw aborted();
            return rows.map((row) => ({
              id: row.id,
              organizationId: row.organizationId,
              runId: row.runId,
              sequence: Number(row.sequence),
              type: row.type as AgentEventRow['type'],
              payloadJson: row.payloadJson,
              visibility: row.visibility as AgentEventRow['visibility'],
              occurredAt:
                row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt),
              projectId: row.projectId,
              phaseId: row.phaseId,
              taskId: row.taskId,
              agentId: row.agentId,
            }));
          } catch (error) {
            if (isAborted(range.signal)) throw aborted();
            throw error;
          } finally {
            range.signal?.removeEventListener('abort', cancel);
          }
        } finally {
          await cancellation?.settled;
          reserved.release();
        }
      },
    },

    previewShares: {
      async getById(shareId: string): Promise<PreviewShareRow | undefined> {
        const [share] = await db
          .select()
          .from(previewShares)
          .where(
            and(eq(previewShares.organizationId, orgId), eq(previewShares.id, shareId)),
          )
          .limit(1);
        return share;
      },

      async listByProject(projectId: string): Promise<PreviewShareRow[]> {
        return await db
          .select()
          .from(previewShares)
          .where(
            and(
              eq(previewShares.organizationId, orgId),
              eq(previewShares.projectId, projectId),
            ),
          )
          .orderBy(desc(previewShares.id));
      },
    },
  };
}
