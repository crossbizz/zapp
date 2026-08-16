import assert from 'node:assert/strict';
import test from 'node:test';

import { editorLanguageForPath } from '../src/components/code/editor-language';
import {
  displayMessageContent,
  mergeCodeReferences,
  serializeMessageContext,
} from '../src/components/conversation/code-references';

void test('maps common workspace paths to CodeMirror languages', () => {
  assert.equal(editorLanguageForPath('src/App.tsx'), 'javascript');
  assert.equal(editorLanguageForPath('src/styles.css'), 'css');
  assert.equal(editorLanguageForPath('index.html'), 'html');
  assert.equal(editorLanguageForPath('package.json'), 'json');
  assert.equal(editorLanguageForPath('README.md'), 'markdown');
  assert.equal(editorLanguageForPath('public/favicon.ico'), 'text');
});

void test('serializes referenced workspace paths into message context', () => {
  assert.equal(serializeMessageContext('Fix the heading.', [], []), 'Fix the heading.');
  assert.deepEqual(JSON.parse(serializeMessageContext('Fix the heading.', ['src/App.tsx'], [])), {
    message: 'Fix the heading.',
    referencedFiles: [{ path: 'src/App.tsx' }],
  });
});

void test('renders durable structured context as the user message instead of raw JSON', () => {
  const serialized = serializeMessageContext(
    'Fix the heading.',
    ['src/App.tsx'],
    [{ selector: '#hero' }],
  );

  assert.equal(displayMessageContent(serialized), 'Fix the heading.');
  assert.equal(
    displayMessageContent('{"message":"ordinary user JSON"}'),
    '{"message":"ordinary user JSON"}',
  );
});

void test('keeps accepted references while reporting capacity rejection', () => {
  assert.deepEqual(mergeCodeReferences(['src/one.ts'], ['src/two.ts', 'src/three.ts'], 2), {
    accepted: [true, false],
    references: ['src/one.ts', 'src/two.ts'],
    rejected: true,
  });
});
