import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Client } from '@temporalio/client';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';

import type { EventActivities } from './activities/events.js';
import type { SessionActivities } from './activities/session.js';
import type { WorkspaceActivities } from './activities/workspace.js';
import { runWorkflow, RunWorkflowInputSchema } from './workflows/run.js';

export type RunActivities = EventActivities & SessionActivities & WorkspaceActivities;

export interface RunWorkerOptions {
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly activities: RunActivities;
  readonly shutdownGraceTime?: WorkerOptions['shutdownGraceTime'];
  readonly maxHeartbeatThrottleInterval?: WorkerOptions['maxHeartbeatThrottleInterval'];
}

function workflowPath(): string {
  const source = fileURLToPath(new URL('./workflows/run.ts', import.meta.url));
  if (existsSync(source)) return source;
  return fileURLToPath(new URL('./workflows/run.js', import.meta.url));
}

export function createRunWorker(options: RunWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    taskQueue: options.taskQueue,
    workflowsPath: workflowPath(),
    activities: options.activities,
    ...(options.shutdownGraceTime === undefined
      ? {}
      : { shutdownGraceTime: options.shutdownGraceTime }),
    ...(options.maxHeartbeatThrottleInterval === undefined
      ? {}
      : { maxHeartbeatThrottleInterval: options.maxHeartbeatThrottleInterval }),
  });
}

export interface TemporalOrchestrator {
  startRun(input: unknown): Promise<void>;
}

export function createTemporalOrchestrator(options: {
  readonly client: Pick<Client, 'workflow'>;
  readonly taskQueue: string;
}): TemporalOrchestrator {
  return {
    async startRun(inputValue) {
      const input = RunWorkflowInputSchema.parse(inputValue);
      await options.client.workflow.start(runWorkflow, {
        taskQueue: options.taskQueue,
        workflowId: input.workflowId,
        args: [input],
      });
    },
  };
}
