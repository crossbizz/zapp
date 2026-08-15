import assert from 'node:assert/strict';
import test from 'node:test';

import { isVisibleWorkspacePath } from '../src/components/code/workspace-paths';

void test('keeps project source visible while hiding repository and generated internals', () => {
  for (const path of [
    'src/main.ts',
    'src/components/App.tsx',
    'package.json',
    'public/favicon.svg',
  ]) {
    assert.equal(isVisibleWorkspacePath(path), true, path);
  }

  for (const path of [
    '.git',
    '.git/config',
    'node_modules',
    'node_modules/vite/package.json',
    'dist/index.html',
    '.vite/deps/react.js',
    'coverage/index.html',
    'tsconfig.tsbuildinfo',
  ]) {
    assert.equal(isVisibleWorkspacePath(path), false, path);
  }
});
