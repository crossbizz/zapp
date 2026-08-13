import { z } from 'zod';

const IdentifierSchema = z.string().min(1).max(160);
const uniqueStringListSchema = (minimum = 0) =>
  z
    .array(z.string().min(1).max(1_024))
    .min(minimum)
    .max(1_000)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'plan_duplicate_list_value' });
      }
    });

export const PlanPhaseSchema = z
  .object({
    id: IdentifierSchema,
    sequence: z.number().int().positive(),
    title: z.string().min(1).max(500),
    acceptanceCriteria: uniqueStringListSchema(1),
    approvalAfter: z.boolean(),
    optional: z.boolean().default(false),
  })
  .strict();
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;

export const PlanTaskEstimateSchema = z
  .object({
    credits: z.number().int().nonnegative().max(1_000_000),
    wallClockMinutes: z.number().int().positive().max(60 * 24 * 30),
  })
  .strict();

export const PlanTaskSchema = z
  .object({
    id: IdentifierSchema,
    phaseId: IdentifierSchema,
    title: z.string().min(1).max(500),
    dependsOn: z.array(IdentifierSchema).max(1_000),
    riskLevel: z.enum(['low', 'medium', 'high']),
    requiredTools: uniqueStringListSchema(),
    expectedFiles: uniqueStringListSchema(),
    acceptanceCriteriaIds: uniqueStringListSchema(1),
    requiredTests: uniqueStringListSchema(),
    estimate: PlanTaskEstimateSchema,
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

function findCycle(tasks: readonly PlanTask[]): readonly string[] | undefined {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn] as const));
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): readonly string[] | undefined => {
    if (active.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      return [...path.slice(cycleStart), taskId];
    }
    if (visited.has(taskId)) return undefined;

    active.add(taskId);
    path.push(taskId);
    for (const dependencyId of dependencies.get(taskId) ?? []) {
      const cycle = visit(dependencyId);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    active.delete(taskId);
    visited.add(taskId);
    return undefined;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

const PlanShapeSchema = z
  .object({
    phases: z.array(PlanPhaseSchema).min(1).max(1_000),
    tasks: z.array(PlanTaskSchema).min(1).max(10_000),
    budget: z
      .object({
        credits: z.number().int().positive().max(1_000_000_000),
        wallClockHours: z.number().positive().max(24 * 365),
      })
      .strict(),
  })
  .strict();

const PlanShapeWithDefaultsSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || !('phases' in value)) return value;
  const phases = (value as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) return value;
  const phaseValues: unknown[] = phases;
  return {
    ...value,
    phases: phaseValues.map((phase) =>
      typeof phase === 'object' && phase !== null && !('optional' in phase)
        ? { ...phase, optional: false }
        : phase,
    ),
  };
}, PlanShapeSchema);

export const PlanSchema = PlanShapeWithDefaultsSchema.superRefine((plan, context) => {
  const phaseIds = new Set<string>();
  const phaseSequences = new Set<number>();
  for (const [index, phase] of plan.phases.entries()) {
    if (phaseIds.has(phase.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan_phase_duplicate',
        path: ['phases', index, 'id'],
      });
    }
    if (phaseSequences.has(phase.sequence)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan_phase_sequence_duplicate',
        path: ['phases', index, 'sequence'],
      });
    }
    phaseIds.add(phase.id);
    phaseSequences.add(phase.sequence);
  }

  const taskIds = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (taskIds.has(task.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan_task_duplicate',
        path: ['tasks', index, 'id'],
      });
    }
    taskIds.add(task.id);
    if (!phaseIds.has(task.phaseId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan_task_phase_missing',
        path: ['tasks', index, 'phaseId'],
      });
    }
  }

  for (const [index, task] of plan.tasks.entries()) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan_task_dependency_duplicate',
        path: ['tasks', index, 'dependsOn'],
      });
    }
    for (const [dependencyIndex, dependencyId] of task.dependsOn.entries()) {
      if (!taskIds.has(dependencyId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_task_dependency_missing',
          path: ['tasks', index, 'dependsOn', dependencyIndex],
        });
      }
    }
  }

  const dependenciesAreResolvable = plan.tasks.every((task) =>
    task.dependsOn.every((dependencyId) => taskIds.has(dependencyId)),
  );
  if (taskIds.size === plan.tasks.length && dependenciesAreResolvable) {
    const cycle = findCycle(plan.tasks);
    if (cycle !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `plan_cycle:${cycle.join('->')}`,
        path: ['tasks'],
      });
    }
  }
});
export type Plan = z.infer<typeof PlanSchema>;

export const TaskStateSchema = z.enum([
  'queued',
  'blocked',
  'ready',
  'running',
  'waiting_for_approval',
  'verifying',
  'repairing',
  'passed',
  'failed',
  'cancelled',
  'superseded',
]);

export const TaskGraphStateSchema = z
  .object({
    tasks: z.record(
      z
        .object({
          status: TaskStateSchema,
          branchId: z.string().min(1).max(512),
        })
        .strict(),
    ),
  })
  .strict();
export type TaskGraphState = z.infer<typeof TaskGraphStateSchema>;
