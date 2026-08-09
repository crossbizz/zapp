import { z } from 'zod';

import {
  PlanSchema,
  TaskGraphStateSchema,
  type Plan,
  type PlanTask,
  type TaskGraphState,
} from './schema.js';

export {
  PlanPhaseSchema,
  PlanSchema,
  PlanTaskEstimateSchema,
  PlanTaskSchema,
  TaskGraphStateSchema,
  TaskStateSchema,
} from './schema.js';
export type { Plan, PlanPhase, PlanTask, TaskGraphState } from './schema.js';

const ACTIVE_WRITER_STATES = new Set([
  'ready',
  'running',
  'waiting_for_approval',
  'verifying',
  'repairing',
]);

export interface TaskGraph {
  readyTasks(state: TaskGraphState): readonly PlanTask[];
}

class ValidatedTaskGraph implements TaskGraph {
  constructor(private readonly plan: Plan) {}

  readyTasks(stateValue: TaskGraphState): readonly PlanTask[] {
    const state = TaskGraphStateSchema.parse(stateValue);
    const planTaskIds = new Set(this.plan.tasks.map(({ id }) => id));
    const stateTaskIds = Object.keys(state.tasks);
    const missing = this.plan.tasks.find(({ id }) => state.tasks[id] === undefined);
    if (missing !== undefined) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: 'task_graph_state_missing',
          path: ['tasks', missing.id],
        },
      ]);
    }
    const unknown = stateTaskIds.find((taskId) => !planTaskIds.has(taskId));
    if (unknown !== undefined) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: 'task_graph_state_unknown',
          path: ['tasks', unknown],
        },
      ]);
    }

    const activeBranches = new Set(
      stateTaskIds
        .map((taskId) => state.tasks[taskId])
        .filter(
          (entry): entry is NonNullable<typeof entry> =>
            entry !== undefined && ACTIVE_WRITER_STATES.has(entry.status),
        )
        .map(({ branchId }) => branchId),
    );
    const selectedBranches = new Set<string>();
    const ready: PlanTask[] = [];

    for (const task of this.plan.tasks) {
      const current = state.tasks[task.id];
      if (current?.status !== 'queued') continue;
      if (
        !task.dependsOn.every(
          (dependencyId) => state.tasks[dependencyId]?.status === 'passed',
        )
      ) {
        continue;
      }
      if (activeBranches.has(current.branchId) || selectedBranches.has(current.branchId)) continue;
      selectedBranches.add(current.branchId);
      ready.push(task);
    }

    return ready;
  }
}

export function createTaskGraph(planValue: unknown): TaskGraph {
  return new ValidatedTaskGraph(PlanSchema.parse(planValue));
}
