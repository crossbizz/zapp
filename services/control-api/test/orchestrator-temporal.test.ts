import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { SignalRunInputSchema, StartRunInputSchema } from '@zapp/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createTemporalRunOrchestrator } from '../src/orchestrator/temporal.js';
import { DispatchNotStartedError, OrchestratorError } from '../src/orchestrator/port.js';

const identity = {
  runId: `run_${'0'.repeat(26)}`,
  workflowId: 'run:stable-intent',
  organizationId: `org_${'0'.repeat(26)}`,
  projectId: `proj_${'0'.repeat(26)}`,
  branchId: null,
  appType: 'web' as const,
  model: null,
  prompt: 'Build the requested change',
  budget: { maxCredits: 10 },
  planMaxCredits: 100,
  operationKey: `op_${'a'.repeat(64)}`,
};

const fixRequest = {
  source: 'user_bug' as const,
  summary: 'Fix the broken heading',
  relevantCommitSha: 'a'.repeat(40),
  reproductionRef: 'tests/heading.test.ts',
  evidence: [{
    kind: 'user_report' as const,
    artifactId: `art_${'0'.repeat(26)}`,
    summary: 'Heading is wrong',
  }],
};

describe('production Temporal run adapter', () => {
  it.each([
    ['ask', 'runWorkflow'],
    ['prototype', 'runWorkflow'],
    ['build', 'buildWorkflow'],
    ['fix', 'fixWorkflow'],
    ['autonomous', 'autonomousWorkflow'],
  ] as const)('maps %s to %s with a strict worker input', async (mode, workflowType) => {
    const start = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createTemporalRunOrchestrator({ client: { workflow: { start } } as never });

    await orchestrator.startRun(StartRunInputSchema.parse({
      ...identity,
      mode,
      ...(mode === 'fix' ? { fixRequest } : {}),
    }));

    expect(start).toHaveBeenCalledOnce();
    const [actualType, options] = start.mock.calls[0] as [string, { args: unknown[] }];
    expect(actualType).toBe(workflowType);
    expect(options.args).toHaveLength(1);
    if (mode === 'autonomous') {
      expect(options.args[0]).toEqual({
        workflowId: identity.workflowId,
        runId: identity.runId,
        organizationId: identity.organizationId,
        projectId: identity.projectId,
        prompt: identity.prompt,
        model: identity.model,
        budget: identity.budget,
        planMaxCredits: identity.planMaxCredits,
        maxConcurrency: 3,
      });
    } else {
      expect(options.args[0]).toMatchObject({ mode, planMaxCredits: identity.planMaxCredits });
    }
  });

  it('treats AlreadyStarted for the same stable workflow as response-loss replay success', async () => {
    const start = vi.fn().mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError('already started', identity.workflowId, 'buildWorkflow'),
    );
    const orchestrator = createTemporalRunOrchestrator({ client: { workflow: { start } } as never });

    await expect(orchestrator.startRun({ ...identity, mode: 'build' })).resolves.toBeUndefined();
  });

  it('treats a failed start as response-loss success only when describe finds the correct workflow type', async () => {
    const describe = vi.fn().mockResolvedValue({ type: 'buildWorkflow' });
    const orchestrator = createTemporalRunOrchestrator({
      client: {
        workflow: {
          start: vi.fn().mockRejectedValue(new Error('response lost')),
          getHandle: () => ({ describe }),
        },
      } as never,
    });

    await expect(orchestrator.startRun({ ...identity, mode: 'build' })).resolves.toBeUndefined();
    expect(describe).toHaveBeenCalledOnce();
  });

  it('reports a definitive absent execution without hiding it as an ambiguous outage', async () => {
    const orchestrator = createTemporalRunOrchestrator({
      client: {
        workflow: {
          start: vi.fn().mockRejectedValue(new Error('start unavailable')),
          getHandle: () => ({
            describe: () => Promise.reject(
              new WorkflowNotFoundError('not found', identity.workflowId, undefined),
            ),
          }),
        },
      } as never,
    });

    await expect(orchestrator.startRun({ ...identity, mode: 'build' })).rejects.toBeInstanceOf(
      DispatchNotStartedError,
    );
  });

  it.each([
    ['describe is unavailable', () => Promise.reject(new Error('describe unavailable'))],
    ['the workflow type differs', () => Promise.resolve({ type: 'fixWorkflow' })],
  ])('keeps dispatch ambiguous when %s', async (_label, describe) => {
    const orchestrator = createTemporalRunOrchestrator({
      client: {
        workflow: {
          start: vi.fn().mockRejectedValue(new Error('start unavailable')),
          getHandle: () => ({ describe }),
        },
      } as never,
    });

    await expect(orchestrator.startRun({ ...identity, mode: 'build' })).rejects.toBeInstanceOf(
      OrchestratorError,
    );
  });

  it.each(['build', 'autonomous', 'fix'] as const)(
    'uses the exact credit-exhaustion wire contract for %s',
    async (mode) => {
      const signal = vi.fn().mockResolvedValue(undefined);
      const orchestrator = createTemporalRunOrchestrator({
        client: { workflow: { getHandle: () => ({ signal }) } } as never,
      });
      await orchestrator.signalRun({
        runId: identity.runId,
        workflowId: identity.workflowId,
        mode,
        signal: 'credit_balance_exhausted',
        operationKey: identity.operationKey,
      });

      expect(signal).toHaveBeenCalledWith('creditBalanceExhausted', {
        runId: identity.runId,
        operationKey: identity.operationKey,
      });
    },
  );

  it.each([
    ['pause', 'pause', { runId: identity.runId, operationKey: identity.operationKey }],
    ['resume', 'resume', { runId: identity.runId, operationKey: identity.operationKey }],
    ['cancel', 'cancel', { runId: identity.runId, operationKey: identity.operationKey }],
    ['redirect', 'redirect', { runId: identity.runId, instruction: 'Change direction', operationKey: identity.operationKey }],
  ] as const)('uses exact %s signal name and envelope', async (publicSignal, wireSignal, envelope) => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createTemporalRunOrchestrator({
      client: { workflow: { getHandle: () => ({ signal }) } } as never,
    });
    await orchestrator.signalRun(SignalRunInputSchema.parse({
      runId: identity.runId,
      workflowId: identity.workflowId,
      mode: 'fix',
      signal: publicSignal,
      ...(publicSignal === 'redirect' ? { prompt: 'Change direction' } : {}),
      operationKey: identity.operationKey,
    }));
    expect(signal).toHaveBeenCalledWith(wireSignal, envelope);
  });

  it.each(['ask', 'prototype', 'build', 'autonomous', 'fix'] as const)(
    'projects the reason-bound budget approval envelope accepted by the %s workflow',
    async (mode) => {
      const signal = vi.fn().mockResolvedValue(undefined);
      const orchestrator = createTemporalRunOrchestrator({
        client: { workflow: { getHandle: () => ({ signal }) } } as never,
      });
      await orchestrator.signalRun(SignalRunInputSchema.parse({
        runId: identity.runId,
        workflowId: identity.workflowId,
        mode,
        signal: 'budget_approval',
        approvalId: `appr_${'0'.repeat(26)}`,
        decision: 'approved',
        absoluteCeiling: '100.0000',
        reason: 'organization_credit_exhausted',
        operationKey: identity.operationKey,
      }));

      expect(signal).toHaveBeenCalledWith('budgetApprovalResolved', {
        approvalId: `appr_${'0'.repeat(26)}`,
        decision: 'approved',
        absoluteCeiling: '100.0000',
        reason: 'organization_credit_exhausted',
      });
    },
  );
});
