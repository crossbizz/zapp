import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { expect, expectTypeOf, test } from 'vitest';

import { GateRegistry, requiredGates, type GateContext } from '../src/index.js';

test('publishes the root barrel as the built package entry', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { exports?: { '.'?: { types?: unknown; default?: unknown } } };

  expect(manifest.exports?.['.']).toEqual({
    types: './dist/index.d.ts',
    default: './dist/index.js',
  });
  expect(new GateRegistry().ids()).toEqual([]);
  expect(requiredGates('compatible', { waivers: [] })).toHaveLength(15);
});

test('binds gate execution to the workspace runtime interface', () => {
  expectTypeOf<GateContext['runtime']>().toEqualTypeOf<WorkspaceRuntime>();
});
