import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubble } from '../src/components/conversation/MessageBubble';
import { formatConversationTimestamp } from '../src/components/conversation/message-time';
import { ToolActivityLine } from '../src/components/conversation/ToolActivityLine';

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

void test('rolls structured tool activity into one reader-friendly summary', () => {
  const activities = [
    {
      sequence: 1,
      state: 'started',
      summary: 'Started write file',
      tool: 'write_file',
      toolCallId: 'write-package',
    },
    {
      affectedPaths: ['package.json'],
      sequence: 2,
      state: 'completed',
      summary: 'Wrote package.json',
      tool: 'write_file',
      toolCallId: 'write-package',
    },
    {
      affectedPaths: ['tsconfig.json'],
      sequence: 3,
      state: 'completed',
      summary: 'Wrote tsconfig.json',
      tool: 'write_file',
      toolCallId: 'write-tsconfig',
    },
    {
      count: 3,
      sequence: 4,
      state: 'completed',
      summary: 'Installed 3 dependencies',
      tool: 'install_dependency',
      toolCallId: 'install-runtime',
    },
    {
      count: 7,
      sequence: 5,
      state: 'completed',
      summary: 'Installed 7 dependencies',
      tool: 'install_dependency',
      toolCallId: 'install-dev',
    },
  ] as const;

  const markup = renderToStaticMarkup(createElement(ToolActivityLine, { activities }));

  assert.match(
    markup,
    /<summary><span>Updated 2 project files · Installed 10 dependencies ✓<\/span>/u,
  );
  assert.match(markup, />Details<\/span>/u);
  assert.match(markup, /Started write file \(started\)/u);
  assert.match(markup, /Wrote package\.json \(completed\)/u);
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:=|\s|>)/u);
});

void test('keeps a failed tool summary prominent while retaining prior details', () => {
  const activities = [
    {
      sequence: 1,
      state: 'completed',
      summary: 'Wrote package.json',
      tool: 'write_file',
      toolCallId: 'write-package',
    },
    {
      sequence: 2,
      state: 'failed',
      summary: 'Command failed',
      tool: 'run_command',
      toolCallId: 'run-tests',
    },
  ] as const;

  const markup = renderToStaticMarkup(createElement(ToolActivityLine, { activities }));

  assert.match(markup, /<summary><span>Command failed !<\/span>/u);
  assert.doesNotMatch(markup, /<summary>[^<]*Wrote package\.json/u);
  assert.match(markup, /Wrote package\.json \(completed\)/u);
});

void test('keeps active work visible beside completed activity', () => {
  const activities = [
    {
      affectedPaths: ['package.json'],
      sequence: 1,
      state: 'completed',
      summary: 'Wrote package.json',
      tool: 'write_file',
      toolCallId: 'write-package',
    },
    {
      sequence: 2,
      state: 'started',
      summary: 'Started install dependency',
      tool: 'install_dependency',
      toolCallId: 'install-runtime',
    },
  ] as const;

  const markup = renderToStaticMarkup(createElement(ToolActivityLine, { activities }));

  assert.match(markup, /Updated 1 project file · Installing dependencies…/u);
});

void test('counts affected files instead of file tool calls', () => {
  const activities = [
    {
      affectedPaths: ['package.json'],
      sequence: 1,
      state: 'completed',
      summary: 'Wrote package.json',
      tool: 'write_file',
      toolCallId: 'write-package-first',
    },
    {
      affectedPaths: ['package.json'],
      sequence: 2,
      state: 'completed',
      summary: 'Wrote package.json again',
      tool: 'write_file',
      toolCallId: 'write-package-second',
    },
    {
      affectedPaths: ['package.json'],
      sequence: 3,
      state: 'completed',
      summary: 'Wrote package.json a third time',
      tool: 'write_file',
      toolCallId: 'write-package-third',
    },
    {
      filesChanged: 2,
      sequence: 4,
      state: 'completed',
      summary: 'Applied 3 hunks across 2 files',
      tool: 'apply_patch',
      toolCallId: 'patch-source',
    },
  ] as const;

  const markup = renderToStaticMarkup(createElement(ToolActivityLine, { activities }));

  assert.match(markup, /Updated 3 project files ✓/u);
});

void test('pairs legacy lifecycle events without tool call ids', () => {
  const activities = [
    {
      sequence: 1,
      state: 'started',
      summary: 'Started write file',
      tool: 'write_file',
    },
    {
      affectedPaths: ['package.json'],
      sequence: 2,
      state: 'completed',
      summary: 'Wrote package.json',
      tool: 'write_file',
    },
  ] as const;

  const markup = renderToStaticMarkup(createElement(ToolActivityLine, { activities }));

  assert.match(markup, /Updated 1 project file ✓/u);
});

void test('uses distinct summaries for canonical checks, migrations, and releases', () => {
  const activities = [
    {
      sequence: 1,
      state: 'completed',
      summary: 'Build passed',
      tool: 'run_build',
      toolCallId: 'build',
    },
    {
      sequence: 2,
      state: 'completed',
      summary: 'Migration migration-1 applied in production',
      tool: 'execute_migration',
      toolCallId: 'migration',
    },
    {
      sequence: 3,
      state: 'completed',
      summary: 'Deployment deployment-1 started for release release-1',
      tool: 'deploy_release',
      toolCallId: 'release',
    },
  ] as const;

  const markup = renderToStaticMarkup(createElement(ToolActivityLine, { activities }));

  assert.match(
    markup,
    /Ran project checks · Applied a database migration · Updated the release ✓/u,
  );
});
