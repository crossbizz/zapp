import type { Client } from '@temporalio/client';

import { OrchestratorError, SignalRunInputSchema, StartRunInputSchema, type OrchestratorPort } from './port.js';

const AGENT_RUN_TASK_QUEUE = 'agent-runs';

/** Shipping Temporal adapter; control-api owns the public port, workers own execution. */
export function createTemporalRunOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
}): OrchestratorPort {
  return {
    async startRun(rawInput) {
      const input = StartRunInputSchema.parse(rawInput);
      const workflowType =
        input.mode === 'autonomous'
          ? 'autonomousWorkflow'
          : input.mode === 'fix' || input.mode === 'build'
            ? 'buildWorkflow'
            : 'runWorkflow';
      try {
        await options.client.workflow.start(workflowType, {
          taskQueue: AGENT_RUN_TASK_QUEUE,
          workflowId: input.workflowId,
          args: [input],
        });
      } catch (error) {
        throw new OrchestratorError(error instanceof Error ? error.message : 'Temporal start failed');
      }
    },
    async signalRun(rawInput) {
      const input = SignalRunInputSchema.parse(rawInput);
      const signalName =
        input.signal === 'credit_balance_exhausted'
          ? 'creditBalanceExhausted'
          : input.signal === 'budget_approval'
            ? 'budgetApprovalResolved'
            : input.signal === 'pause'
              ? 'pauseRun'
              : input.signal === 'resume'
                ? 'resumeRun'
                : input.signal === 'cancel'
                  ? 'cancelRun'
                  : input.signal === 'redirect'
                    ? 'redirectRun'
                    : 'messageRun';
      try {
        const handle = options.client.workflow.getHandle(input.workflowId);
        if (input.signal === 'budget_approval') {
          await handle.signal(signalName, {
            approvalId: input.approvalId,
            decision: input.decision,
            ...(input.decision === 'approved' ? { absoluteCeiling: input.absoluteCeiling } : {}),
          });
        } else if (input.signal === 'message') {
          await handle.signal(signalName, {
            runId: input.runId,
            message: input.message,
            operationKey: input.operationKey,
          });
        } else if (input.signal === 'redirect') {
          await handle.signal(signalName, {
            runId: input.runId,
            instruction: input.prompt,
            operationKey: input.operationKey,
          });
        } else {
          await handle.signal(signalName, { runId: input.runId, operationKey: input.operationKey });
        }
        return { applied: true };
      } catch (error) {
        throw new OrchestratorError(error instanceof Error ? error.message : 'Temporal signal failed');
      }
    },
  };
}
