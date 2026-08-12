import { defineSignal } from '@temporalio/workflow';
import type { Plan } from '@zapp/planning-engine';
import { z } from 'zod';

const idSchema = (prefix: 'run' | 'phase' | 'task'): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u'));
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);

export const RetryFailedTaskSignalSchema = z
  .object({
    runId: idSchema('run'),
    taskId: idSchema('task'),
    operationKey: OperationKeySchema,
  })
  .strict();
export type RetryFailedTaskSignal = z.infer<typeof RetryFailedTaskSignalSchema>;

export const SkipOptionalPhaseSignalSchema = z
  .object({
    runId: idSchema('run'),
    phaseId: idSchema('phase'),
    operationKey: OperationKeySchema,
  })
  .strict();
export type SkipOptionalPhaseSignal = z.infer<typeof SkipOptionalPhaseSignalSchema>;

export const retryFailedTaskSignal = defineSignal<[unknown]>('retryFailedTask');
export const skipOptionalPhaseSignal = defineSignal<[unknown]>('skipOptionalPhase');

export type BuilderControlEligibility =
  | { readonly accepted: true; readonly reason: 'eligible' }
  | {
      readonly accepted: false;
      readonly reason:
        | 'task_not_found'
        | 'task_not_failed'
        | 'dependencies_unsatisfied'
        | 'phase_not_found'
        | 'phase_required'
        | 'phase_task_started'
        | 'phase_already_skipped';
    };

export function retryFailedTaskEligibility(
  plan: Plan,
  taskId: string,
  failedTaskIds: readonly string[],
  completedTaskIds: readonly string[],
): BuilderControlEligibility {
  const task = plan.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return { accepted: false, reason: 'task_not_found' };
  if (!failedTaskIds.includes(taskId)) return { accepted: false, reason: 'task_not_failed' };
  const completed = new Set(completedTaskIds);
  if (!task.dependsOn.every((dependencyId) => completed.has(dependencyId))) {
    return { accepted: false, reason: 'dependencies_unsatisfied' };
  }
  return { accepted: true, reason: 'eligible' };
}

export function skipOptionalPhaseEligibility(
  plan: Plan,
  phaseId: string,
  startedTaskIds: readonly string[],
  skippedPhaseIds: readonly string[],
): BuilderControlEligibility {
  const phase = plan.phases.find(({ id }) => id === phaseId);
  if (phase === undefined) return { accepted: false, reason: 'phase_not_found' };
  if (!phase.optional) return { accepted: false, reason: 'phase_required' };
  if (skippedPhaseIds.includes(phaseId)) {
    return { accepted: false, reason: 'phase_already_skipped' };
  }
  const phaseTaskIds = new Set(
    plan.tasks.filter((task) => task.phaseId === phaseId).map(({ id }) => id),
  );
  if (startedTaskIds.some((taskId) => phaseTaskIds.has(taskId))) {
    return { accepted: false, reason: 'phase_task_started' };
  }
  return { accepted: true, reason: 'eligible' };
}
