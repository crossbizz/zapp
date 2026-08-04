import { z } from 'zod';
import { idSchema } from './ids.js';

/** PRD §14.4, in order. Both the membership and the order are contractual. */
export const AGENT_EVENT_TYPES = [
  'run.created',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.completed',
  'phase.created',
  'phase.started',
  'phase.completed',
  'task.created',
  'task.started',
  'task.blocked',
  'task.updated',
  'task.completed',
  'task.failed',
  'agent.started',
  'agent.completed',
  'tool.started',
  'tool.output',
  'tool.completed',
  'tool.failed',
  'approval.requested',
  'approval.resolved',
  'artifact.created',
  'commit.created',
  'test.started',
  'test.completed',
  'verification.completed',
  'preview.starting',
  'preview.ready',
  'preview.failed',
  'release.created',
  'deployment.updated',
  'usage.recorded',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/**
 * Who an event is for: the end user's timeline, internal machinery, or support
 * staff debugging someone else's run.
 */
export const AgentEventVisibilitySchema = z.enum(['user', 'internal', 'support']);

export type AgentEventVisibility = z.infer<typeof AgentEventVisibilitySchema>;

/**
 * PRD §14.4. Events are immutable, ordered per run by `sequence`, replayable,
 * and idempotently consumable — Mission Control reads these, never chat text.
 */
export const AgentEventSchema = z.object({
  id: idSchema('evt'),
  runId: idSchema('run'),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
  phaseId: idSchema('phase').optional(),
  taskId: idSchema('task').optional(),
  // Not an id: agents are roles (PRD §15.2 — planner, coder, verifier), and no
  // table has a row per agent for this to point at.
  agentId: z.string().min(1).optional(),
  type: z.enum(AGENT_EVENT_TYPES),
  visibility: AgentEventVisibilitySchema,
  payload: z.record(z.unknown()),
});

export type AgentEvent = z.infer<typeof AgentEventSchema>;
