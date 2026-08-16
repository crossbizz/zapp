import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPES,
  AgentEventSchema,
  AgentEventVisibilitySchema,
  AttachmentRefSchema,
  MessageAppliedPayloadSchema,
  PreviewLifecycleEventSchema,
} from '../src/events.js';

// The accepted-event test below intentionally keeps its own literal: it is the
// PRD §14.4 example verbatim and must not drift with the fixture the rejection
// cases mutate.
const baseEvent = {
  id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7N8',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
  sequence: 42,
  occurredAt: '2026-08-03T12:00:00.000Z',
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  type: 'tool.completed',
  visibility: 'user',
  payload: { tool: 'run_build', exitCode: 0, userSummary: 'Ran the build' },
};

describe('AgentEventSchema', () => {
  it('accepts a valid tool.completed event', () => {
    const evt = {
      id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7N8',
      runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
      sequence: 42,
      occurredAt: '2026-08-03T12:00:00.000Z',
      organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
      projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
      type: 'tool.completed',
      visibility: 'user',
      payload: { tool: 'run_build', exitCode: 0, userSummary: 'Ran the build' },
    };
    expect(AgentEventSchema.parse(evt)).toMatchObject(evt);
  });
  it('accepts the optional phase, task and agent identifiers', () => {
    const evt = {
      ...baseEvent,
      phaseId: 'phase_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
      taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
      // A role name, not an id: `agent_runs` has agents, `agent_tasks` records
      // which role ran, and neither is a row of its own (PRD §15.2).
      agentId: 'coder',
    };
    expect(AgentEventSchema.parse(evt)).toMatchObject(evt);
  });
  it('leaves absent optional identifiers absent instead of setting undefined', () => {
    const parsed = AgentEventSchema.parse(baseEvent);
    expect('phaseId' in parsed).toBe(false);
    expect('taskId' in parsed).toBe(false);
    expect('agentId' in parsed).toBe(false);
  });
  it('rejects unknown event types and negative sequence', () => {
    expect(AgentEventSchema.safeParse({ ...baseEvent, type: 'tool.exploded' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...baseEvent, sequence: -1 }).success).toBe(false);
  });
  it('rejects a non-integer sequence', () => {
    expect(AgentEventSchema.safeParse({ ...baseEvent, sequence: 1.5 }).success).toBe(false);
  });
  it('rejects an event missing a required field', () => {
    const withoutProjectId: Partial<typeof baseEvent> = { ...baseEvent };
    delete withoutProjectId.projectId;
    expect(AgentEventSchema.safeParse(withoutProjectId).success).toBe(false);
  });
  it('rejects an unknown visibility', () => {
    expect(AgentEventSchema.safeParse({ ...baseEvent, visibility: 'public' }).success).toBe(false);
  });
  it('rejects identifiers carrying the wrong prefix, no prefix, or nothing at all', () => {
    expect(AgentEventSchema.safeParse({ ...baseEvent, id: baseEvent.runId }).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({ ...baseEvent, taskId: '01J8ME7YQZJ2V9Q0X3T5B6K7NC' }).success,
    ).toBe(false);
    expect(AgentEventSchema.safeParse({ ...baseEvent, phaseId: '' }).success).toBe(false);
    // `agent_phases` is a real table with a `phase_` id since FND-6, so the
    // producer-local string this field used to accept is no longer valid.
    expect(AgentEventSchema.safeParse({ ...baseEvent, phaseId: 'phase_1' }).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({ ...baseEvent, phaseId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC' })
        .success,
    ).toBe(false);
  });

  it('keeps agentId a role name rather than a typed id', () => {
    // Agent roles (PRD §15.2) are not rows, so this field stays a plain string —
    // extending the TypeID list must not silently turn it into an id.
    expect(AgentEventSchema.safeParse({ ...baseEvent, agentId: 'verifier' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...baseEvent, agentId: '' }).success).toBe(false);
  });
  it('rejects an occurredAt that is not an ISO 8601 timestamp', () => {
    expect(AgentEventSchema.safeParse({ ...baseEvent, occurredAt: '2026-08-03' }).success).toBe(
      false,
    );
  });
});

describe('AGENT_EVENT_TYPES', () => {
  it('is exactly the PRD §14.4 list, in order', () => {
    // Written out rather than derived: this literal is the contract, so adding,
    // dropping, renaming or reordering a type has to fail here first.
    expect(AGENT_EVENT_TYPES).toEqual([
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
      'message.applied',
      'conversation.card',
      'conversation.response',
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
    ]);
    // Catches a duplicate pasted into both the source list and the pin above.
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
  });
  it('event type list matches PRD count', () => {
    expect(AGENT_EVENT_TYPES).toHaveLength(39);
  });
});

describe('PreviewLifecycleEventSchema', () => {
  const envelope = {
    eventKey: 'ws13:preview-contract',
    organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
    projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
    runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
    taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
    occurredAt: '2026-08-10T18:02:00.000Z',
    visibility: 'user',
  } as const;

  it('pins exact starting, ready, operation-failure, and terminal-failure producer payloads', () => {
    const workspaceId = 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NF';
    expect(
      PreviewLifecycleEventSchema.safeParse({
        ...envelope,
        type: 'preview.starting',
        payload: { workspaceId, action: 'restart' },
      }).success,
    ).toBe(true);
    expect(
      PreviewLifecycleEventSchema.safeParse({
        ...envelope,
        type: 'preview.ready',
        payload: { workspaceId, action: 'start', port: 4_173, supervisorId: 'preview-1' },
      }).success,
    ).toBe(true);
    expect(
      PreviewLifecycleEventSchema.safeParse({
        ...envelope,
        type: 'preview.failed',
        payload: { workspaceId, action: 'restart', code: 'dev_server_operation_failed' },
      }).success,
    ).toBe(true);
    expect(
      PreviewLifecycleEventSchema.safeParse({
        ...envelope,
        type: 'preview.failed',
        payload: { workspaceId, code: 'restart_limit_exceeded', monitorLeaseToken: 'lease-1' },
      }).success,
    ).toBe(true);
    expect(
      PreviewLifecycleEventSchema.safeParse({
        ...envelope,
        type: 'preview.ready',
        payload: { workspaceId, action: 'start' },
      }).success,
    ).toBe(false);
  });
});

describe('conversation event payloads', () => {
  const attachment = {
    attachmentId: 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
    kind: 'image',
    name: 'screen.png',
    byteSize: 1234,
    contentType: 'image/png',
  };

  it('accepts only structured message application acknowledgements', () => {
    const payload = {
      messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
      operationKey: `op_${'a'.repeat(64)}`,
    };
    expect(MessageAppliedPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      AgentEventSchema.safeParse({ ...baseEvent, type: 'message.applied', payload }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        ...baseEvent,
        type: 'message.applied',
        payload: { messageId: payload.messageId },
      }).success,
    ).toBe(false);
  });

  it('accepts up to ten typed image attachments on message.user', () => {
    expect(AttachmentRefSchema.parse(attachment)).toEqual(attachment);
    expect(
      AgentEventSchema.safeParse({
        ...baseEvent,
        type: 'message.user',
        payload: {
          messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
          content: 'Please match these references.',
          attachments: Array.from({ length: 10 }, () => attachment),
          source: 'web',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an eleventh attachment', () => {
    expect(
      AgentEventSchema.safeParse({
        ...baseEvent,
        type: 'message.user',
        payload: {
          messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
          content: 'Too many references.',
          attachments: Array.from({ length: 11 }, () => attachment),
          source: 'web',
        },
      }).success,
    ).toBe(false);
  });

  it('requires exactly one inline or artifact-backed assistant body', () => {
    const event = {
      ...baseEvent,
      type: 'message.assistant',
      payload: {
        messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NG',
        turnId: 'turn_01J8ME7YQZJ2V9Q0X3T5B6K7NH',
        model: 'anthropic/claude-sonnet-5',
      },
    };
    expect(AgentEventSchema.safeParse({ ...event, payload: { ...event.payload, content: 'Done' } }).success).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          contentArtifactId: 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NJ',
        },
      }).success,
    ).toBe(true);
    expect(AgentEventSchema.safeParse(event).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        ...event,
        payload: {
          ...event.payload,
          content: 'Done',
          contentArtifactId: 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NJ',
        },
      }).success,
    ).toBe(false);
  });

  it('requires a non-empty userSummary on user-visible tool lifecycle events', () => {
    expect(
      AgentEventSchema.safeParse({
        ...baseEvent,
        type: 'tool.started',
        payload: { tool: 'run_build' },
      }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        ...baseEvent,
        type: 'tool.failed',
        payload: { tool: 'run_build', userSummary: 'Build failed' },
      }).success,
    ).toBe(true);
  });
});

describe('AgentEventVisibilitySchema', () => {
  it('is exactly user, internal and support', () => {
    expect(AgentEventVisibilitySchema.options).toEqual(['user', 'internal', 'support']);
  });
  it('rejects a visibility outside the list', () => {
    expect(AgentEventVisibilitySchema.safeParse('public').success).toBe(false);
  });
});
