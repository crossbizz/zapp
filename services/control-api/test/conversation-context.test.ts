import { describe, expect, it } from 'vitest';

import {
  conversationContextHash,
  verifiedPriorConversationContext,
} from '../src/conversations/context.js';

const runId = 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const sourceRunId = 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NA';
const conversationId = 'conv_01J8ME7YQZJ2V9Q0X3T5B6K7NB';

function contextValue() {
  return {
    version: 1,
    conversationId,
    sourceRunId,
    messages: [
      {
        runId: sourceRunId,
        runNumber: 1,
        sequence: 1,
        type: 'message.user',
        payload: {
          messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
          content: 'Build the billing page',
          attachments: [],
          source: 'web',
        },
      },
      {
        runId: sourceRunId,
        runNumber: 1,
        sequence: 2,
        type: 'message.assistant',
        payload: {
          messageId: 'msg_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
          turnId: 'turn_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
          content: 'The billing page is ready.',
          model: 'anthropic/claude-sonnet-5',
        },
      },
    ],
  } as const;
}

describe('successor conversation context', () => {
  it('hashes canonical structured content and projects it for the model', () => {
    const context = contextValue();
    const contentHash = conversationContextHash(context);
    const reordered = {
      messages: context.messages,
      sourceRunId,
      conversationId,
      version: 1,
    };
    expect(conversationContextHash(reordered)).toBe(contentHash);

    const projection = verifiedPriorConversationContext(
      { conversationId, runId, contentHash, contextJson: context },
      { id: runId, conversationId },
      'Add invoices',
    );
    expect(projection).toContain('Prior conversation context');
    expect(projection).toContain('Build the billing page');
    expect(projection).toContain('The billing page is ready.');
  });

  it('fails closed when the stored hash or tenant-linked identity changes', () => {
    const context = contextValue();
    const artifact = {
      conversationId,
      runId,
      contentHash: '0'.repeat(64),
      contextJson: context,
    };
    expect(() =>
      verifiedPriorConversationContext(
        artifact,
        { id: runId, conversationId },
        'Add invoices',
      ),
    ).toThrow('content hash');
    expect(() =>
      verifiedPriorConversationContext(
        { ...artifact, contentHash: conversationContextHash(context) },
        { id: sourceRunId, conversationId },
        'Add invoices',
      ),
    ).toThrow('scope');
  });
});
