import { describe, expect, it } from 'vitest';

import {
  SignalRunInputSchema,
  projectTemporalRunSignal,
} from '../src/temporal-run.js';

const runId = 'run_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const taskId = 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NC';
const phaseId = 'phase_01J8ME7YQZJ2V9Q0X3T5B6K7ND';
const approvalId = 'appr_01J8ME7YQZJ2V9Q0X3T5B6K7NE';
const artifactId = 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NF';
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

describe('typed approval Temporal signals', () => {
  it.each([
    ['specification', 'autonomousSpecificationApproval'],
    ['plan', 'autonomousPlanApproval'],
    ['plan_diff', 'autonomousPlanApproval'],
  ] as const)('projects %s to its artifact approval signal', (approvalKind, signalName) => {
    expect(projectTemporalRunSignal({
      runId,
      workflowId: `autonomous:${runId}`,
      mode: 'autonomous',
      operationKey,
      signal: 'approval_decision',
      approvalId,
      approvalKind,
      artifactId,
      decision: 'approved',
    })).toEqual({
      signalName,
      payload: {
        runId,
        approvalId,
        approvalKind,
        artifactId,
        decision: 'approved',
        operationKey,
      },
    });
  });

  it.each(['migration', 'deploy'] as const)(
    'projects %s to the generic approval signal without inventing an artifact',
    (approvalKind) => {
      expect(projectTemporalRunSignal({
        runId,
        workflowId: `fix:${runId}`,
        mode: 'fix',
        operationKey,
        signal: 'approval_decision',
        approvalId,
        approvalKind,
        decision: 'rejected',
      })).toEqual({
        signalName: 'approvalDecision',
        payload: { runId, approvalId, approvalKind, decision: 'rejected', operationKey },
      });
    },
  );

  it('rejects missing artifacts and unsupported approval kinds', () => {
    const base = {
      runId,
      workflowId: `autonomous:${runId}`,
      mode: 'autonomous',
      operationKey,
      signal: 'approval_decision',
      approvalId,
      decision: 'approved',
    } as const;
    expect(SignalRunInputSchema.safeParse({ ...base, approvalKind: 'plan' }).success).toBe(false);
    expect(SignalRunInputSchema.safeParse({
      ...base, approvalKind: 'production_deploy', artifactId,
    }).success).toBe(false);
  });
});
