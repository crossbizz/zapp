import { describe, expect, it } from 'vitest';

import { PlanSchema } from '@zapp/planning-engine';

import {
  retryFailedTaskEligibility,
  skipOptionalPhaseEligibility,
} from '../src/workflows/builder-control.js';
import { BuildModePlanSchema } from '../src/workflows/run.js';

const phaseA = 'phase_01J00000000000000000000001';
const phaseB = 'phase_01J00000000000000000000002';
const taskA = 'task_01J000000000000000000000001';
const taskB = 'task_01J000000000000000000000002';

const plan = PlanSchema.parse({
  phases: [
    {
      id: phaseA,
      sequence: 1,
      title: 'Required foundation',
      acceptanceCriteria: ['AC-1'],
      approvalAfter: false,
    },
    {
      id: phaseB,
      sequence: 2,
      title: 'Optional polish',
      acceptanceCriteria: ['AC-2'],
      approvalAfter: false,
      optional: true,
    },
  ],
  tasks: [
    {
      id: taskA,
      phaseId: phaseA,
      title: 'Build foundation',
      dependsOn: [],
      riskLevel: 'low',
      requiredTools: [],
      expectedFiles: ['src/foundation.ts'],
      acceptanceCriteriaIds: ['AC-1'],
      requiredTests: [],
      estimate: { credits: 1, wallClockMinutes: 1 },
    },
    {
      id: taskB,
      phaseId: phaseB,
      title: 'Polish foundation',
      dependsOn: [taskA],
      riskLevel: 'low',
      requiredTools: [],
      expectedFiles: ['src/polish.ts'],
      acceptanceCriteriaIds: ['AC-2'],
      requiredTests: [],
      estimate: { credits: 1, wallClockMinutes: 1 },
    },
  ],
  budget: { credits: 10, wallClockHours: 1 },
});

describe('retryFailedTaskEligibility', () => {
  it('accepts only a failed task whose dependencies remain completed', () => {
    expect(retryFailedTaskEligibility(plan, taskB, [taskB], [taskA])).toEqual({
      accepted: true,
      reason: 'eligible',
    });
    expect(retryFailedTaskEligibility(plan, taskB, [taskB], [])).toEqual({
      accepted: false,
      reason: 'dependencies_unsatisfied',
    });
    expect(retryFailedTaskEligibility(plan, taskA, [], [])).toEqual({
      accepted: false,
      reason: 'task_not_failed',
    });
    expect(retryFailedTaskEligibility(plan, 'task_01J000000000000000000000009', [], [])).toEqual({
      accepted: false,
      reason: 'task_not_found',
    });
  });
});

describe('skipOptionalPhaseEligibility', () => {
  it('accepts only an optional phase before any phase task starts', () => {
    expect(skipOptionalPhaseEligibility(plan, phaseB, [], [])).toEqual({
      accepted: true,
      reason: 'eligible',
    });
    expect(skipOptionalPhaseEligibility(plan, phaseA, [], [])).toEqual({
      accepted: false,
      reason: 'phase_required',
    });
    expect(skipOptionalPhaseEligibility(plan, phaseB, [taskB], [])).toEqual({
      accepted: false,
      reason: 'phase_task_started',
    });
    expect(skipOptionalPhaseEligibility(plan, phaseB, [], [phaseB])).toEqual({
      accepted: false,
      reason: 'phase_already_skipped',
    });
  });

  it('keeps the single lightweight Build phase required', () => {
    const result = BuildModePlanSchema.safeParse({
      phases: [{
        ...plan.phases[0],
        id: 'phase_01J00000000000000000000011',
        optional: true,
      }],
      tasks: [{
        ...plan.tasks[0],
        id: 'task_01J00000000000000000000011',
        phaseId: 'phase_01J00000000000000000000011',
      }],
      budget: plan.budget,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected optional Build phase rejection');
    expect(result.error.issues.map(({ message }) => message)).toContain('build_phase_must_be_required');
  });
});
