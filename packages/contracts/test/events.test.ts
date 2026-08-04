import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES, AgentEventSchema } from '../src/events.js';

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
  payload: { tool: 'run_build', exitCode: 0 },
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
      payload: { tool: 'run_build', exitCode: 0 },
    };
    expect(AgentEventSchema.parse(evt)).toMatchObject(evt);
  });
  it('accepts the optional phase, task and agent identifiers', () => {
    const evt = {
      ...baseEvent,
      phaseId: 'phase_1',
      taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
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
  });
  it('rejects an occurredAt that is not an ISO 8601 timestamp', () => {
    expect(AgentEventSchema.safeParse({ ...baseEvent, occurredAt: '2026-08-03' }).success).toBe(
      false,
    );
  });
});

describe('AGENT_EVENT_TYPES', () => {
  it('event type list matches PRD count', () => {
    expect(AGENT_EVENT_TYPES).toHaveLength(34);
  });
  it('runs from run.created to usage.recorded with no duplicates', () => {
    expect(AGENT_EVENT_TYPES[0]).toBe('run.created');
    expect(AGENT_EVENT_TYPES.at(-1)).toBe('usage.recorded');
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length);
  });
});
