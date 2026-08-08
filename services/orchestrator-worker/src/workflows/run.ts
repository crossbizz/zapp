import { proxyActivities } from '@temporalio/workflow';
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

export const RunWorkflowResultSchema = z
  .object({
    status: z.literal('completed'),
    commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
  })
  .strict();
export type RunWorkflowResult = z.infer<typeof RunWorkflowResultSchema>;

const workspace = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});
const session = proxyActivities<SessionActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: { initialInterval: '100 milliseconds', maximumAttempts: 5 },
});
const events = proxyActivities<EventActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 5 },
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
  const input = RunWorkflowInputSchema.parse(inputValue);
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
    await events.emitEvents({
      events: [event(input, 'agent.started', 'agent-started', { agent: 'builder' })],
    });
    const sessionResult = await session.runBuilderSession({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workspaceId: ensured.workspaceId,
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
    const committed = await workspace.commitAndPush({
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workspaceId: ensured.workspaceId,
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
