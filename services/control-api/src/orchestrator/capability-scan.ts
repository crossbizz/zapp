import { createHash } from 'node:crypto';

import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
  type WorkflowHandle,
} from '@temporalio/client';
import {
  CapabilityScanInputSchema,
  CapabilityScanOutputSchema,
  type CapabilityScanPort,
} from '@zapp/project-adapters';

const TASK_QUEUE = 'verification';

export interface CapabilityScanWorkflowClient {
  readonly workflow: Pick<Client['workflow'], 'start' | 'getHandle'>;
}

function workflowId(input: { organizationId: string; projectId: string; scanId: string }): string {
  const digest = createHash('sha256')
    .update(`${input.organizationId}\0${input.projectId}\0${input.scanId}`)
    .digest('hex');
  return `capability-scan-${digest}`;
}

export function createTemporalCapabilityScanPort(
  client: CapabilityScanWorkflowClient,
): CapabilityScanPort {
  return {
    async scan(inputValue) {
      const input = CapabilityScanInputSchema.parse(inputValue);
      const id = workflowId(input);
      let handle: WorkflowHandle;
      try {
        handle = await client.workflow.start('capabilityScanWorkflow', {
          taskQueue: TASK_QUEUE,
          workflowId: id,
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          args: [input],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        handle = client.workflow.getHandle(id);
      }
      return CapabilityScanOutputSchema.parse(await handle.result());
    },
  };
}
