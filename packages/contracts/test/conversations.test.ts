import { describe, expect, it } from 'vitest';

import { idSchema } from '../src/ids.js';
import {
  ConversationEventSchema,
  ConversationSummarySchema,
} from '../src/conversations.js';

const conversationId = 'conv_01J8ME7YQZJ2V9Q0X3T5B6K7N8';
const projectId = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const runId = 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NA';

describe('durable conversation contracts', () => {
  it('validates the conversation id and a newest-activity summary', () => {
    expect(idSchema('conv').parse(conversationId)).toBe(conversationId);
    expect(
      ConversationSummarySchema.parse({
        id: conversationId,
        projectId,
        title: 'Repair checkout preview',
        createdAt: '2026-08-16T12:00:00.000Z',
        updatedAt: '2026-08-16T12:01:00.000Z',
        latestRun: { id: runId, status: 'running' },
        runCount: 2,
      }),
    ).toMatchObject({ id: conversationId, runCount: 2 });
  });

  it('uses run number plus the structured event as cross-run identity', () => {
    expect(
      ConversationEventSchema.parse({
        runNumber: 2,
        event: {
          id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
          runId,
          sequence: 1,
          occurredAt: '2026-08-16T12:01:00.000Z',
          organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
          projectId,
          type: 'message.user',
          visibility: 'user',
          payload: {
            messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
            content: 'Keep going',
            attachments: [],
            source: 'web',
          },
        },
      }),
    ).toMatchObject({ runNumber: 2, event: { sequence: 1 } });
  });
});
