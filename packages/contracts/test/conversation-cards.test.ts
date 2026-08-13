import { describe, expect, it } from 'vitest';

import {
  ConversationCardResponseSchema,
  ConversationCardSchema,
  SignalRunInputSchema,
  projectTemporalRunSignal,
} from '../src/index.js';

const runId = 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const operationKey = `op_${'a'.repeat(64)}`;
const cardId = `card_${runId}:interview:0`;

describe('conversation cards', () => {
  it('round-trips each versioned card kind without accepting prose as a decision', () => {
    const approvalId = 'appr_01J8ME7YQZJ2V9Q0X3T5B6K7NE';
    const artifactId = 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NF';
    const cards = [
      {
        version: 1, kind: 'question', cardId,
        questions: [{
          questionId: 'targetUsers', prompt: 'Who is this for?',
          options: [
            { label: 'Developers', tradeoff: 'Narrow audience', recommended: true },
            { label: 'Everyone', tradeoff: 'Broader scope', recommended: false },
          ],
        }],
      },
      { version: 1, kind: 'specification', cardId, approvalId, artifactId: 'spec_01J8ME7YQZJ2V9Q0X3T5B6K7NG', artifactVersion: 1 },
      { version: 1, kind: 'plan', cardId, approvalId, artifactId, approvalKind: 'plan' },
      { version: 1, kind: 'approval', cardId, approvalId, approvalKind: 'deploy' },
    ];
    for (const card of cards) expect(ConversationCardSchema.parse(card)).toEqual(card);
    expect(ConversationCardSchema.safeParse({
      version: 1, kind: 'approval', cardId, approvalId, approvalKind: 'deploy',
      content: 'the user said yes',
    }).success).toBe(false);
  });

  it('requires a matching structured answer set and projects its durable signal', () => {
    const response = {
      version: 1, kind: 'question_answers', cardId,
      answers: [{ questionId: 'targetUsers', answer: 'Developers' }],
    } as const;
    expect(ConversationCardResponseSchema.parse(response)).toEqual(response);
    expect(projectTemporalRunSignal({
      runId, workflowId: `autonomous:${runId}`, mode: 'autonomous', operationKey,
      signal: 'conversation_card_response', cardId, response,
    })).toEqual({
      signalName: 'conversationCardResponse',
      payload: { runId, operationKey, cardId, response },
    });
    expect(SignalRunInputSchema.safeParse({
      runId, workflowId: `autonomous:${runId}`, mode: 'autonomous', operationKey,
      signal: 'conversation_card_response', cardId: `${cardId}:wrong`,
      response,
    }).success).toBe(false);
  });

  it('rejects duplicate question answers', () => {
    expect(ConversationCardResponseSchema.safeParse({
      version: 1, kind: 'question_answers', cardId,
      answers: [
        { questionId: 'targetUsers', answer: 'Developers' },
        { questionId: 'targetUsers', answer: 'Everyone' },
      ],
    }).success).toBe(false);
  });
});
