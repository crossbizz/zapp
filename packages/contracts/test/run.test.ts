import { describe, expect, it } from 'vitest';
import { RunModeSchema, SupportLevelSchema, TaskStateSchema } from '../src/run.js';

// Each list is written out rather than derived from the schema: the literal is
// the contract, so adding, dropping, renaming or reordering a value has to fail
// here first.

describe('TaskStateSchema', () => {
  it('is exactly the PRD §13.2 states, in order', () => {
    expect(TaskStateSchema.options).toEqual([
      'queued',
      'blocked',
      'ready',
      'running',
      'waiting_for_approval',
      'verifying',
      'repairing',
      'passed',
      'failed',
      'cancelled',
      'superseded',
    ]);
  });
  it('rejects a state outside the list', () => {
    expect(TaskStateSchema.safeParse('done').success).toBe(false);
  });
});

describe('RunModeSchema', () => {
  it('is exactly the five run modes, in order', () => {
    expect(RunModeSchema.options).toEqual(['ask', 'prototype', 'build', 'fix', 'autonomous']);
  });
  it('rejects a mode outside the list', () => {
    expect(RunModeSchema.safeParse('yolo').success).toBe(false);
  });
});

describe('SupportLevelSchema', () => {
  it('is exactly the three support levels, in order', () => {
    expect(SupportLevelSchema.options).toEqual(['compatible', 'verified', 'managed']);
  });
  it('rejects a level outside the list', () => {
    expect(SupportLevelSchema.safeParse('unsupported').success).toBe(false);
  });
});
