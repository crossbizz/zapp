import { continueAsNew, proxyActivities, type RetryPolicy } from '@temporalio/workflow';
import { z } from 'zod';

import type { EventActivities, PendingAgentEvent } from '../activities/events.js';
import type { SessionActivities } from '../activities/session.js';
import type { WorkspaceActivities } from '../activities/workspace.js';

const workflowIdSchema = (prefix: 'run' | 'org' | 'proj' | 'br'): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

export const RunWorkflowInputSchema = z
  .object({
    runId: workflowIdSchema('run'),
    workflowId: z.string().min(1).max(255),
    organizationId: workflowIdSchema('org'),
    projectId: workflowIdSchema('proj'),
    branchId: workflowIdSchema('br').nullable(),
    mode: z.enum(['ask', 'prototype', 'build', 'fix', 'autonomous']),
    appType: z.enum(['web', 'mobile']),
    model: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
      .nullable(),
    prompt: z.string().min(1).max(20_000),
    budget: z
      .object({ maxCredits: z.number().int().positive().max(1_000_000) })
      .strict()
      .nullable(),
    operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
  })
  .strict();
export type RunWorkflowInput = z.infer<typeof RunWorkflowInputSchema>;

const RunWorkflowContinuationSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('session'), workspaceId: z.string().min(1).max(512) }).strict(),
  z.object({ phase: z.literal('commit'), workspaceId: z.string().min(1).max(512) }).strict(),
]);
const RunWorkflowStateSchema = RunWorkflowInputSchema.extend({
  continuation: RunWorkflowContinuationSchema.optional(),
}).strict();

export const RunWorkflowResultSchema = z
  .object({
    status: z.literal('completed'),
    commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  })
  .strict();
export type RunWorkflowResult = z.infer<typeof RunWorkflowResultSchema>;

export const ACTIVITY_RETRY_POLICY: RetryPolicy = {
  initialInterval: '100 milliseconds',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [
    'activity_idempotency_conflict',
    'activity_idempotency_key_required',
    'activity_idempotency_corrupt',
  ],
};

const workspace = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});
const session = proxyActivities<SessionActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: ACTIVITY_RETRY_POLICY,
});
const events = proxyActivities<EventActivities>({
  startToCloseTimeout: '30 seconds',
  retry: ACTIVITY_RETRY_POLICY,
});

function operationKey(input: RunWorkflowInput, step: string): string {
  return `${input.runId}:task-m1:${step}`;
}

function event(
  input: RunWorkflowInput,
  type: PendingAgentEvent['type'],
  suffix: string,
  payload: Record<string, unknown>,
): PendingAgentEvent {
  return {
    eventKey: `${input.runId}:task-m1:${suffix}`,
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    occurredAt: new Date().toISOString(),
    type,
    visibility: 'user',
    payload,
  };
}

export async function runWorkflow(inputValue: unknown): Promise<RunWorkflowResult> {
  const input = RunWorkflowStateSchema.parse(inputValue);
  if (input.continuation === undefined) {
    let workspaceId: string;
    try {
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'running',
        idempotencyKey: operationKey(input, 'status-running'),
      });
      await events.emitEvents({
        events: [
          event(input, 'run.started', 'run-started', {
            mode: input.mode,
            appType: input.appType,
            model: input.model,
          }),
        ],
      });

      const ensured = await workspace.ensureWorkspace({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        appType: input.appType,
        idempotencyKey: operationKey(input, 'ensure-workspace'),
      });
      workspaceId = ensured.workspaceId;
    } catch (error: unknown) {
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
    return continueAsNew<typeof runWorkflow>({
      ...input,
      continuation: { phase: 'session', workspaceId },
    });
  }

  if (input.continuation.phase === 'session') {
    try {
      await events.emitEvents({
        events: [event(input, 'agent.started', 'agent-started', { agent: 'builder' })],
      });
      const sessionResult = await session.runBuilderSession({
        runId: input.runId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        workspaceId: input.continuation.workspaceId,
        mode: input.mode,
        model: input.model,
        prompt: input.prompt,
        budget: input.budget,
        idempotencyKey: operationKey(input, 'builder-session'),
      });
      switch (sessionResult.status) {
        case 'completed':
          break;
        case 'needs_approval':
        case 'budget_exhausted':
        case 'failed':
        case 'cancelled':
          throw new Error(`builder_session_${sessionResult.status}`);
      }
    } catch (error: unknown) {
      await events.transitionRunStatus({
        runId: input.runId,
        status: 'failed',
        idempotencyKey: operationKey(input, 'status-failed'),
      });
      throw error;
    }
    return continueAsNew<typeof runWorkflow>({
      ...input,
      continuation: { phase: 'commit', workspaceId: input.continuation.workspaceId },
    });
  }

  try {
    const committed = await workspace.commitAndPush({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workspaceId: input.continuation.workspaceId,
      message: 'Complete M1 builder task',
      idempotencyKey: operationKey(input, 'commit-and-push'),
    });
    await events.emitEvents({
      events: [
        event(input, 'commit.created', 'commit-created', { commitSha: committed.commitSha }),
        event(input, 'run.completed', 'run-completed', { status: 'completed' }),
      ],
    });
    await events.transitionRunStatus({
      runId: input.runId,
      status: 'completed',
      idempotencyKey: operationKey(input, 'status-completed'),
    });
    return RunWorkflowResultSchema.parse({
      status: 'completed',
      commitSha: committed.commitSha,
    });
  } catch (error: unknown) {
    await events.transitionRunStatus({
      runId: input.runId,
      status: 'failed',
      idempotencyKey: operationKey(input, 'status-failed'),
    });
    throw error;
  }
}
