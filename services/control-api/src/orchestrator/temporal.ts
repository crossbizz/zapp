import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
} from '@temporalio/client';
import { projectTemporalRunSignal, projectTemporalRunStart } from '@zapp/contracts';

import {
  DispatchNotStartedError,
  OrchestratorError,
  SignalRunInputSchema,
  StartRunInputSchema,
  type OrchestratorPort,
} from './port.js';

const AGENT_RUN_TASK_QUEUE = 'agent-runs';

/** Shipping Temporal adapter; control-api owns the public port, workers own execution. */
export function createTemporalRunOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
}): OrchestratorPort {
  return {
    async startRun(rawInput) {
      const input = StartRunInputSchema.parse(rawInput);
      const projected = projectTemporalRunStart(input);
      try {
        await options.client.workflow.start(projected.workflowType, {
          taskQueue: AGENT_RUN_TASK_QUEUE,
          workflowId: input.workflowId,
          args: [projected.input],
        });
      } catch (error) {
        if (
          error instanceof WorkflowExecutionAlreadyStartedError &&
          error.workflowId === input.workflowId &&
          error.workflowType === projected.workflowType
        ) return;
        try {
          const description = await options.client.workflow.getHandle(input.workflowId).describe();
          if (description.type === projected.workflowType) return;
          throw new OrchestratorError('Temporal workflow identity does not match the durable intent');
        } catch (describeError) {
          if (describeError instanceof WorkflowNotFoundError) throw new DispatchNotStartedError();
          if (describeError instanceof OrchestratorError) throw describeError;
          throw new OrchestratorError(
            describeError instanceof Error
              ? describeError.message
              : error instanceof Error
                ? error.message
                : 'Temporal start reconciliation failed',
          );
        }
      }
    },
    async signalRun(rawInput) {
      const input = SignalRunInputSchema.parse(rawInput);
      const projected = projectTemporalRunSignal(input);
      try {
        const handle = options.client.workflow.getHandle(input.workflowId);
        await handle.signal(projected.signalName, projected.payload);
        return { applied: true };
      } catch (error) {
        throw new OrchestratorError(error instanceof Error ? error.message : 'Temporal signal failed');
      }
    },
  };
}
