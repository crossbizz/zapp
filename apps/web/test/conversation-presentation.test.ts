import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/components/conversation/MessageBubble';
import { formatConversationTimestamp } from '../src/components/conversation/message-time';

void test('formats current-day messages with their exact local time', () => {
  assert.equal(
    formatConversationTimestamp(
      '2026-08-16T15:05:00.000Z',
      new Date('2026-08-16T17:00:00.000Z'),
      'UTC',
    ),
    '3:05 PM',
  );
});

void test('labels yesterday and preserves the exact message time', () => {
  assert.equal(
    formatConversationTimestamp(
      '2026-08-15T15:05:00.000Z',
      new Date('2026-08-16T17:00:00.000Z'),
      'UTC',
    ),
    'Yesterday, 3:05 PM',
  );
});

void test('shows a compact date for older messages and rejects invalid timestamps', () => {
  assert.equal(
    formatConversationTimestamp(
      '2026-08-10T15:05:00.000Z',
      new Date('2026-08-16T17:00:00.000Z'),
      'UTC',
    ),
    'Aug 10, 3:05 PM',
  );
  assert.equal(formatConversationTimestamp('not-a-date'), undefined);
});

void test('defers localized timestamp text until browser hydration', () => {
  const markup = renderToStaticMarkup(
    createElement(MessageBubble, {
      content: 'A persisted message',
      role: 'user',
      timestamp: '2026-08-16T12:00:00.000Z',
    }),
  );

  assert.doesNotMatch(markup, /<time/u);
});
