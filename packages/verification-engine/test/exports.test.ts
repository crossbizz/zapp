import { GateRegistry, requiredGates, type GateContext } from '@zapp/verification-engine';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { expect, expectTypeOf, test } from 'vitest';

test('exports the gate registry and matrix from the package root', () => {
  expect(new GateRegistry().ids()).toEqual([]);
  expect(requiredGates('compatible', { waivers: [] })).toHaveLength(15);
});

test('binds gate execution to the workspace runtime interface', () => {
  expectTypeOf<GateContext['runtime']>().toEqualTypeOf<WorkspaceRuntime>();
});
