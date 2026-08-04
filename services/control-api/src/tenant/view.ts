import { AgentEventVisibilitySchema, RunModeSchema, SupportLevelSchema } from '@zapp/contracts';
import type { AgentEventRow, AgentRun, Project } from '@zapp/db';
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
