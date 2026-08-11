import { describe, expect, it } from 'vitest';

import {
  applyPlanDiff,
  dependentTaskClosure,
  isMaterialPlanDiff,
  PlanDiffSchema,
} from '../src/diff.js';

const phase = {
  id: 'phase_1',
  sequence: 1,
  title: 'Build',
  acceptanceCriteria: ['AC-1'],
  approvalAfter: false,
};

const task = (id: string, dependsOn: readonly string[] = []) => ({
  id,
  phaseId: phase.id,
  title: id,
  dependsOn: [...dependsOn],
  riskLevel: 'low' as const,
  requiredTools: ['read_file'],
  expectedFiles: [`src/${id}.ts`],
  acceptanceCriteriaIds: ['AC-1'],
  requiredTests: [`test/${id}.test.ts`],
  estimate: { credits: 1, wallClockMinutes: 5 },
});

const plan = {
  phases: [phase],
  tasks: [
    task('task_a'),
    task('task_b', ['task_a']),
    task('task_c', ['task_a']),
    task('task_d', ['task_b', 'task_c']),
  ],
  budget: { credits: 20, wallClockHours: 1 },
};

describe('AR-20 PlanDiff', () => {
  it('computes the full dependent closure for tasks that must pause', () => {
    expect(dependentTaskClosure(plan, ['task_b'])).toEqual(['task_b', 'task_d']);
  });

  it('applies a strict diff and treats any declared impact as material', () => {
    const diff = PlanDiffSchema.parse({
      addedTasks: [task('task_e', ['task_c'])],
      removedTaskIds: ['task_b'],
      modifiedTasks: [
        {
          ...task('task_d', ['task_c', 'task_e']),
          title: 'task_d updated',
        },
      ],
      supersededTaskIds: ['task_b'],
      impact: {
        scope: true,
        costDelta: false,
        archChange: false,
        dataChange: false,
      },
    });

    expect(isMaterialPlanDiff(plan, diff)).toBe(true);
    expect(applyPlanDiff(plan, diff).tasks.map(({ id }) => id)).toEqual([
      'task_a',
      'task_c',
      'task_d',
      'task_e',
    ]);
  });

  it('fails closed when structural scope changes understate their impact', () => {
    const addedTaskDiff = PlanDiffSchema.parse({
      addedTasks: [task('task_e', ['task_c'])],
      removedTaskIds: [],
      modifiedTasks: [],
      supersededTaskIds: [],
      impact: {
        scope: false,
        costDelta: false,
        archChange: false,
        dataChange: false,
      },
    });
    const copyOnlyDiff = PlanDiffSchema.parse({
      addedTasks: [],
      removedTaskIds: [],
      modifiedTasks: [{ ...task('task_b', ['task_a']), title: 'Clearer primary copy' }],
      supersededTaskIds: [],
      impact: {
        scope: false,
        costDelta: false,
        archChange: false,
        dataChange: false,
      },
    });

    expect(isMaterialPlanDiff(plan, addedTaskDiff)).toBe(true);
    expect(isMaterialPlanDiff(plan, copyOnlyDiff)).toBe(false);
  });

  it('refuses to remove a task without preserving it as superseded history', () => {
    expect(() =>
      PlanDiffSchema.parse({
        addedTasks: [],
        removedTaskIds: ['task_b'],
        modifiedTasks: [],
        supersededTaskIds: [],
        impact: {
          scope: false,
          costDelta: false,
          archChange: false,
          dataChange: false,
        },
      }),
    ).toThrowError(/plan_diff_removed_task_not_superseded/u);
  });
});
