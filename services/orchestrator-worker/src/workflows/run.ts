import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  type RetryPolicy,
} from '@temporalio/workflow';
import { z } from 'zod';

import type { EventActivities, PendingAgentEvent } from '../activities/events.js';
import type { ApprovalActivities } from '../activities/approvals.js';
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
  budgetAttempt: z.number().int().nonnegative().max(100).optional(),
}).strict();

export const RunWorkflowResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      commitSha: z.string().regex(/^[0-9a-f]{40,64}$/u),
    })
    .strict(),
  z.object({ status: z.literal('cancelled'), checkpointRef: z.string().min(1) }).strict(),
]);
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
const approvals = proxyActivities<ApprovalActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACTIVITY_RETRY_POLICY,
});

const BudgetApprovalResolutionSchema = z.discriminatedUnion('decision', [
  z
    .object({
      approvalId: z.string().regex(/^appr_[0-9A-HJKMNP-TV-Z]{26}$/u),
      decision: z.literal('approved'),
      absoluteCeiling: z.string().regex(/^\d+\.\d{4}$/u),
    })
    .strict(),
  z
    .object({
      approvalId: z.string().regex(/^appr_[0-9A-HJKMNP-TV-Z]{26}$/u),
      decision: z.literal('rejected'),
    })
    .strict(),
]);
export const budgetApprovalResolvedSignal = defineSignal<[unknown]>('budgetApprovalResolved');

const M1_COMMIT_MESSAGE = 'Complete M1 builder task';

function operationKey(input: RunWorkflowInput, step: string): string {
  return `${input.runId}:task-m1:${step}`;
}

function nextRunCreditCeiling(currentMaxCredits: number): string {
  if (currentMaxCredits >= 1_000_000) throw new Error('run credit ceiling cannot be increased');
  return `${String(Math.min(1_000_000, currentMaxCredits * 2))}.0000`;
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
  const budgetResolutions = new Map<string, z.infer<typeof BudgetApprovalResolutionSchema>>();
  setHandler(budgetApprovalResolvedSignal, (value) => {
    const resolution = BudgetApprovalResolutionSchema.parse(value);
    budgetResolutions.set(resolution.approvalId, resolution);
  });
  const budgetAttempt = input.budgetAttempt ?? 0;
  if (input.continuation === undefined) {
    let workspaceId: string;
    try {
      const estimate =
        input.budget === null
          ? undefined
          : await approvals.estimateRunCost({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              mode: input.mode,
              prompt: input.prompt,
              maxCredits: input.budget.maxCredits,
              idempotencyKey: operationKey(input, 'estimate-run-cost'),
            });
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
            ...(estimate === undefined
              ? {}
              : {
                  estimatedCredits: estimate.estimatedCredits,
                  maxCredits: input.budget?.maxCredits,
                }),
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
      budgetAttempt,
    });
  }

  if (input.continuation.phase === 'session') {
    let approvedMaxCredits: number | undefined;
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
        idempotencyKey: operationKey(input, `builder-session-${String(budgetAttempt)}`),
      });
      switch (sessionResult.status) {
        case 'completed':
          break;
        case 'budget_exhausted': {
          if (input.budget === null) throw new Error('builder_session_budget_exhausted');
          const currentCeiling = `${String(input.budget.maxCredits)}.0000`;
          const requested = await approvals.requestBudgetIncrease({
            runId: input.runId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            workspaceId: input.continuation.workspaceId,
            currentCeiling,
            absoluteCeiling: nextRunCreditCeiling(input.budget.maxCredits),
            idempotencyKey: operationKey(
              input,
              `budget-increase-${String(budgetAttempt)}`,
            ),
          });
          await events.transitionRunStatus({
            runId: input.runId,
            status: 'waiting_for_approval',
            idempotencyKey: operationKey(
              input,
              `status-waiting-for-approval-${String(budgetAttempt)}`,
            ),
          });
          await events.emitEvents({
            events: [
              event(input, 'approval.requested', `budget-approval-${String(budgetAttempt)}`, {
                approvalId: requested.approvalId,
                type: 'budget_increase',
                absoluteCeiling: requested.absoluteCeiling,
              }),
            ],
          });
          await condition(() => budgetResolutions.has(requested.approvalId));
          const resolution = budgetResolutions.get(requested.approvalId);
          if (resolution === undefined) throw new Error('budget approval resolution disappeared');
          await events.emitEvents({
            events: [
              event(input, 'approval.resolved', `budget-resolution-${String(budgetAttempt)}`, {
                approvalId: requested.approvalId,
                decision: resolution.decision,
              }),
            ],
          });
          if (resolution.decision === 'rejected') {
            const checkpoint = await approvals.checkpointBudgetStop({
              runId: input.runId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              workspaceId: input.continuation.workspaceId,
              approvalId: requested.approvalId,
              idempotencyKey: operationKey(
                input,
                `budget-stop-checkpoint-${String(budgetAttempt)}`,
              ),
            });
            await events.emitEvents({
              events: [
                event(input, 'artifact.created', `budget-checkpoint-${String(budgetAttempt)}`, {
                  checkpointRef: checkpoint.checkpointRef,
                }),
                event(input, 'run.cancelled', `budget-cancelled-${String(budgetAttempt)}`, {
                  reason: 'budget_increase_rejected',
                }),
              ],
            });
            await events.transitionRunStatus({
              runId: input.runId,
              status: 'cancelled',
              idempotencyKey: operationKey(input, 'status-cancelled'),
            });
            return RunWorkflowResultSchema.parse({
              status: 'cancelled',
              checkpointRef: checkpoint.checkpointRef,
            });
          }
          if (resolution.absoluteCeiling !== requested.absoluteCeiling) {
            throw new Error('approved budget ceiling does not match the requested ceiling');
          }
          approvedMaxCredits = Number.parseInt(resolution.absoluteCeiling, 10);
          await events.transitionRunStatus({
            runId: input.runId,
            status: 'running',
            idempotencyKey: operationKey(
              input,
              `status-budget-resumed-${String(budgetAttempt)}`,
            ),
          });
          break;
        }
        case 'needs_approval':
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
    if (approvedMaxCredits !== undefined) {
      return continueAsNew<typeof runWorkflow>({
        ...input,
        budget: { maxCredits: approvedMaxCredits },
        budgetAttempt: budgetAttempt + 1,
        continuation: {
          phase: 'session',
          workspaceId: input.continuation.workspaceId,
        },
      });
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
      message: M1_COMMIT_MESSAGE,
      idempotencyKey: operationKey(input, 'commit-and-push'),
    });
    await events.emitEvents({
      events: [
        event(input, 'commit.created', 'commit-created', {
          commitSha: committed.commitSha,
          message: M1_COMMIT_MESSAGE,
          diffstat: committed.diffstat,
        }),
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

export { runTaskBatchWorkflow, taskWorkflow } from './task.js';
