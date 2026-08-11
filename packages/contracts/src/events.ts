import { z } from 'zod';
import { idSchema } from './id-schema.js';
import { ModelIdentifierSchema } from './run-intent.js';

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
  'message.user',
  'message.assistant',
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

const OpaqueMessageIdSchema = z.string().regex(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u);
const OpaqueTurnIdSchema = z.string().regex(/^turn_[0-9A-HJKMNP-TV-Z]{26}$/u);

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const AttachmentRefSchema = z
  .object({
    attachmentId: idSchema('art'),
    kind: z.literal('image'),
    name: z.string().trim().min(1).max(255),
    byteSize: z.number().int().positive().max(8 * 1024 * 1024),
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const MessageUserPayloadSchema = z
  .object({
    messageId: OpaqueMessageIdSchema,
    content: z.string().trim().min(1).max(20_000),
    attachments: z.array(AttachmentRefSchema).max(10),
    source: z.enum(['web', 'desktop', 'api']),
  })
  .strict();
export type MessageUserPayload = z.infer<typeof MessageUserPayloadSchema>;

export const MessageAssistantPayloadSchema = z
  .object({
    messageId: OpaqueMessageIdSchema,
    turnId: OpaqueTurnIdSchema,
    content: z.string().min(1).optional(),
    contentArtifactId: idSchema('art').optional(),
    model: ModelIdentifierSchema,
  })
  .strict()
  .superRefine((payload, ctx) => {
    if ((payload.content === undefined) === (payload.contentArtifactId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of content or contentArtifactId is required',
      });
    }
    if (
      payload.content !== undefined &&
      utf8ByteLength(payload.content) > 48 * 1024
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inline content exceeds 48 KiB' });
    }
  });
export type MessageAssistantPayload = z.infer<typeof MessageAssistantPayloadSchema>;

/**
 * PRD §14.4. Events are immutable, ordered per run by `sequence`, replayable,
 * and idempotently consumable — Mission Control reads these, never chat text.
 */
export const AgentEventObjectSchema = z.object({
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
}).strict();

function validateEventPayload(
  event: { readonly type: AgentEventType; readonly payload: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const parsed =
    event.type === 'message.user'
      ? MessageUserPayloadSchema.safeParse(event.payload)
      : event.type === 'message.assistant'
        ? MessageAssistantPayloadSchema.safeParse(event.payload)
        : undefined;
  if (parsed !== undefined && !parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ['payload', ...issue.path] });
    }
  }
  if (
    (event.type === 'tool.started' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed') &&
    (typeof event.payload['userSummary'] !== 'string' ||
      event.payload['userSummary'].trim().length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload', 'userSummary'],
      message: 'Tool lifecycle events require a userSummary',
    });
  }
}

export const AgentEventInputObjectSchema = AgentEventObjectSchema.omit({
  id: true,
  sequence: true,
}).strict();
export const AgentEventInputSchema = AgentEventInputObjectSchema.superRefine(validateEventPayload);
export const AgentEventSchema = AgentEventObjectSchema.superRefine(validateEventPayload);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
