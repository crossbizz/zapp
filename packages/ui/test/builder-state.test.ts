import { describe, expect, it } from 'vitest';
import { reduceBuilderEvents, type BuilderEvent } from '../src/builder-state';

function event(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>> = {},
): BuilderEvent {
  return { id: String(sequence), type, data: { sequence, payload } };
}

describe('shared builder event projection', () => {
  it('keeps conversation, Mission Control, preview, and deployment state in one ordered projection', () => {
    const snapshot = reduceBuilderEvents([
      event(8, 'deployment.updated', {
        stage: 'go_live',
        status: 'passed',
        summary: 'Production is live',
      }),
      event(1, 'run.started'),
      event(2, 'message.user', { content: 'Build a store' }),
      event(3, 'message.assistant', { content: 'Building it now' }),
      event(4, 'approval.requested', { approvalId: 'approval_1' }),
      event(5, 'preview.ready', { workspaceId: 'workspace_1' }),
      event(6, 'run.paused'),
      event(7, 'run.resumed'),
    ]);

    expect(snapshot).toEqual({
      approvalIds: ['approval_1'],
      deployment: {
        stage: 'go_live',
        status: 'passed',
        summary: 'Production is live',
      },
      messages: [
        { role: 'user', content: 'Build a store' },
        { role: 'assistant', content: 'Building it now' },
      ],
      previewStatus: 'ready',
      runStatus: 'running',
    });
  });

  it('projects terminal preview failure and ignores malformed deployment payloads', () => {
    expect(
      reduceBuilderEvents([
        event(1, 'preview.starting'),
        event(2, 'deployment.updated', { stage: 'go_live', status: 'passed' }),
        event(3, 'preview.failed'),
      ]),
    ).toMatchObject({ deployment: undefined, previewStatus: 'failed' });
  });
});
