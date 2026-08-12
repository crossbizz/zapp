import { describe, expect, it } from 'vitest';

import {
  SignalRunInputSchema,
  projectTemporalRunSignal,
} from '../src/temporal-run.js';

const runId = 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const taskId = 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC';
const phaseId = 'phase_01J8ME7YQZJ2V9Q0X3T5B6K7ND';
const operationKey = `op_${'a'.repeat(64)}`;

describe('builder control Temporal signals', () => {
  it.each([
    {
      input: {
        runId,
        workflowId: `autonomous:${runId}`,
        mode: 'autonomous',
        operationKey,
        signal: 'retry_failed_task',
        taskId,
      },
      expected: {
        signalName: 'retryFailedTask',
        payload: { runId, operationKey, taskId },
      },
    },
    {
      input: {
        runId,
        workflowId: `build:${runId}`,
        mode: 'build',
        operationKey,
        signal: 'skip_optional_phase',
        phaseId,
      },
      expected: {
        signalName: 'skipOptionalPhase',
        payload: { runId, operationKey, phaseId },
      },
    },
  ] as const)('projects $input.signal with its keyed target', ({ input, expected }) => {
    expect(projectTemporalRunSignal(input)).toEqual(expected);
  });

  it('rejects malformed targets and modes without a builder task graph', () => {
    expect(
      SignalRunInputSchema.safeParse({
        runId,
        workflowId: `autonomous:${runId}`,
        mode: 'autonomous',
        operationKey,
        signal: 'retry_failed_task',
        taskId: 'task_invalid',
      }).success,
    ).toBe(false);
    expect(
      SignalRunInputSchema.safeParse({
        runId,
        workflowId: `ask:${runId}`,
        mode: 'ask',
        operationKey,
        signal: 'skip_optional_phase',
        phaseId,
      }).success,
    ).toBe(false);
  });
});
