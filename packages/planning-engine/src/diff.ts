import { z } from 'zod';

import { PlanSchema, PlanTaskSchema, type Plan, type PlanTask } from './schema.js';

const uniqueTaskIdList = z
  .array(z.string().min(1).max(160))
  .max(10_000)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan_diff_duplicate_task_id',
      });
    }
  });

const uniqueTasks = z.array(PlanTaskSchema).max(10_000).superRefine((tasks, context) => {
  if (new Set(tasks.map(({ id }) => id)).size !== tasks.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'plan_diff_duplicate_task',
    });
  }
});

export const PlanDiffImpactSchema = z
  .object({
    scope: z.boolean(),
    costDelta: z.boolean(),
    archChange: z.boolean(),
    dataChange: z.boolean(),
  })
  .strict();
export type PlanDiffImpact = z.infer<typeof PlanDiffImpactSchema>;

export const PlanDiffSchema = z
  .object({
    addedTasks: uniqueTasks,
    removedTaskIds: uniqueTaskIdList,
    modifiedTasks: uniqueTasks,
    supersededTaskIds: uniqueTaskIdList,
    impact: PlanDiffImpactSchema,
  })
  .strict()
  .superRefine((diff, context) => {
    const addedIds = new Set(diff.addedTasks.map(({ id }) => id));
    const modifiedIds = new Set(diff.modifiedTasks.map(({ id }) => id));
    const supersededIds = new Set(diff.supersededTaskIds);

    for (const [index, task] of diff.modifiedTasks.entries()) {
      if (addedIds.has(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_diff_task_added_and_modified',
          path: ['modifiedTasks', index, 'id'],
        });
      }
      if (supersededIds.has(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_diff_task_modified_and_superseded',
          path: ['modifiedTasks', index, 'id'],
        });
      }
    }
    for (const [index, taskId] of diff.removedTaskIds.entries()) {
      if (!supersededIds.has(taskId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_diff_removed_task_not_superseded',
          path: ['removedTaskIds', index],
        });
      }
      if (modifiedIds.has(taskId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_diff_task_removed_and_modified',
          path: ['removedTaskIds', index],
        });
      }
    }
  });
export type PlanDiff = z.infer<typeof PlanDiffSchema>;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function derivePlanDiffImpact(
  planValue: unknown,
  diffValue: unknown,
): PlanDiffImpact {
  const plan = PlanSchema.parse(planValue);
  const diff = PlanDiffSchema.parse(diffValue);
  const nextPlan = applyPlanDiff(plan, diff);
  const currentById = new Map(plan.tasks.map((task) => [task.id, task] as const));
  let scope = diff.addedTasks.length > 0 || diff.supersededTaskIds.length > 0;
  let archChange = false;
  for (const modified of diff.modifiedTasks) {
    const current = currentById.get(modified.id);
    if (current === undefined) continue;
    const copyOnly = sameJson(modified, { ...current, title: modified.title });
    if (!copyOnly) scope = true;
    if (
      current.phaseId !== modified.phaseId ||
      !sameJson(current.dependsOn, modified.dependsOn) ||
      !sameJson(current.requiredTools, modified.requiredTools) ||
      !sameJson(current.expectedFiles, modified.expectedFiles)
    ) {
      archChange = true;
    }
  }
  const estimate = (candidate: Plan): readonly [number, number] => [
    candidate.tasks.reduce((total, task) => total + task.estimate.credits, 0),
    candidate.tasks.reduce((total, task) => total + task.estimate.wallClockMinutes, 0),
  ];
  const costDelta = !sameJson(estimate(plan), estimate(nextPlan));
  return PlanDiffImpactSchema.parse({
    scope: scope || diff.impact.scope,
    costDelta: costDelta || diff.impact.costDelta,
    archChange: archChange || diff.impact.archChange,
    dataChange: diff.impact.dataChange,
  });
}

export function isMaterialPlanDiff(planValue: unknown, diffValue: unknown): boolean {
  const impact = derivePlanDiffImpact(planValue, diffValue);
  return impact.scope || impact.costDelta || impact.archChange || impact.dataChange;
}

export function dependentTaskClosure(
  planValue: unknown,
  seedTaskIdsValue: readonly string[],
): readonly string[] {
  const plan = PlanSchema.parse(planValue);
  const seedTaskIds = uniqueTaskIdList.parse(seedTaskIdsValue);
  const knownTaskIds = new Set(plan.tasks.map(({ id }) => id));
  const unknownTaskId = seedTaskIds.find((taskId) => !knownTaskIds.has(taskId));
  if (unknownTaskId !== undefined) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'plan_diff_seed_task_missing',
        path: ['seedTaskIds', seedTaskIds.indexOf(unknownTaskId)],
      },
    ]);
  }

  const dependents = new Map<string, string[]>();
  for (const task of plan.tasks) {
    for (const dependencyId of task.dependsOn) {
      const existing = dependents.get(dependencyId) ?? [];
      existing.push(task.id);
      dependents.set(dependencyId, existing);
    }
  }

  const affected = new Set(seedTaskIds);
  const queue = [...seedTaskIds];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependentId of dependents.get(queue[index] ?? '') ?? []) {
      if (affected.has(dependentId)) continue;
      affected.add(dependentId);
      queue.push(dependentId);
    }
  }
  return plan.tasks.filter(({ id }) => affected.has(id)).map(({ id }) => id);
}

function assertDiffReferencesPlan(plan: Plan, diff: PlanDiff): void {
  const currentIds = new Set(plan.tasks.map(({ id }) => id));
  const invalidAdded = diff.addedTasks.find(({ id }) => currentIds.has(id));
  const invalidModified = diff.modifiedTasks.find(({ id }) => !currentIds.has(id));
  const invalidSuperseded = diff.supersededTaskIds.find((taskId) => !currentIds.has(taskId));
  const issue =
    invalidAdded === undefined
      ? invalidModified === undefined
        ? invalidSuperseded === undefined
          ? undefined
          : {
              message: 'plan_diff_superseded_task_missing',
              path: ['supersededTaskIds', diff.supersededTaskIds.indexOf(invalidSuperseded)],
            }
        : {
            message: 'plan_diff_modified_task_missing',
            path: ['modifiedTasks', diff.modifiedTasks.indexOf(invalidModified), 'id'],
          }
      : {
          message: 'plan_diff_added_task_exists',
          path: ['addedTasks', diff.addedTasks.indexOf(invalidAdded), 'id'],
        };
  if (issue !== undefined) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, ...issue }]);
  }
}

export function applyPlanDiff(planValue: unknown, diffValue: unknown): Plan {
  const plan = PlanSchema.parse(planValue);
  const diff = PlanDiffSchema.parse(diffValue);
  assertDiffReferencesPlan(plan, diff);

  const supersededIds = new Set(diff.supersededTaskIds);
  const modifiedById = new Map(diff.modifiedTasks.map((task) => [task.id, task] as const));
  const retainedTasks: PlanTask[] = [];
  for (const task of plan.tasks) {
    if (supersededIds.has(task.id)) continue;
    retainedTasks.push(modifiedById.get(task.id) ?? task);
  }

  return PlanSchema.parse({
    ...plan,
    tasks: [...retainedTasks, ...diff.addedTasks],
  });
}
