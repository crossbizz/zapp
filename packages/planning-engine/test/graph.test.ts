import { describe, expect, test } from 'vitest';

import { createTaskGraph, PlanSchema, type TaskGraphState } from '../src/graph.js';

const task = (
  id: string,
  phaseId: string,
  dependsOn: readonly string[] = [],
) => ({
  id,
  phaseId,
  title: id.replaceAll('_', ' '),
  dependsOn,
  riskLevel: 'low' as const,
  requiredTools: ['read_file'],
  expectedFiles: [`src/${id}.ts`],
  acceptanceCriteriaIds: [`AC-${id}`],
  requiredTests: [`test/${id}.test.ts`],
  estimate: { credits: 10, wallClockMinutes: 15 },
});

const appendixCPlan = {
  phases: [
    {
      id: 'phase_0',
      sequence: 1,
      title: 'Architecture proof',
      acceptanceCriteria: ['AC-detect_project_contract'],
      approvalAfter: true,
    },
    {
      id: 'phase_1',
      sequence: 2,
      title: 'Foundation',
      acceptanceCriteria: ['AC-create_application_shell'],
      approvalAfter: false,
    },
    {
      id: 'phase_2',
      sequence: 3,
      title: 'Core workflow',
      acceptanceCriteria: ['AC-implement_client_records'],
      approvalAfter: false,
    },
    {
      id: 'phase_3',
      sequence: 4,
      title: 'Billing and administration',
      acceptanceCriteria: ['AC-configure_stripe_test_mode'],
      approvalAfter: false,
    },
    {
      id: 'phase_4',
      sequence: 5,
      title: 'Production readiness',
      acceptanceCriteria: ['AC-run_security_checks'],
      approvalAfter: false,
    },
  ],
  tasks: [
    task('detect_project_contract', 'phase_0'),
    task('create_application_shell', 'phase_1', ['detect_project_contract']),
    task('implement_client_records', 'phase_2', ['create_application_shell']),
    task('configure_stripe_test_mode', 'phase_3', ['implement_client_records']),
    task('run_security_checks', 'phase_4', ['configure_stripe_test_mode']),
  ],
  budget: { credits: 500, wallClockHours: 8 },
};

const state = (
  entries: ReadonlyArray<
    readonly [string, TaskGraphState['tasks'][string]['status'], string]
  >,
): TaskGraphState => ({
  tasks: Object.fromEntries(
    entries.map(([id, status, branchId]) => [id, { status, branchId }]),
  ),
});

describe('PlanSchema', () => {
  test('defaults legacy phase metadata to required and preserves explicit optional phases', () => {
    const parsed = PlanSchema.parse({
      ...appendixCPlan,
      phases: [appendixCPlan.phases[0], { ...appendixCPlan.phases[1], optional: true }],
      tasks: [
        task('detect_project_contract', 'phase_0'),
        task('create_application_shell', 'phase_1', ['detect_project_contract']),
      ],
    });

    expect(parsed.phases.map(({ optional }) => optional)).toEqual([false, true]);
  });

  test('rejects dependency cycles at plan creation with plan_cycle', () => {
    const cyclic = {
      ...appendixCPlan,
      tasks: [task('task_a', 'phase_0', ['task_b']), task('task_b', 'phase_0', ['task_a'])],
    };

    expect(() => PlanSchema.parse(cyclic)).toThrowError(/plan_cycle/u);
  });
});

describe('TaskGraph.readyTasks', () => {
  test('schedules a diamond only after all dependencies pass', () => {
    const plan = {
      phases: [appendixCPlan.phases[0]],
      tasks: [
        task('task_a', 'phase_0'),
        task('task_b', 'phase_0', ['task_a']),
        task('task_c', 'phase_0', ['task_a']),
        task('task_d', 'phase_0', ['task_b', 'task_c']),
      ],
      budget: appendixCPlan.budget,
    };
    const graph = createTaskGraph(plan);

    expect(
      graph.readyTasks(
        state([
          ['task_a', 'queued', 'branch-a'],
          ['task_b', 'queued', 'branch-b'],
          ['task_c', 'queued', 'branch-c'],
          ['task_d', 'queued', 'branch-d'],
        ]),
      ).map(({ id }) => id),
    ).toEqual(['task_a']);

    expect(
      graph.readyTasks(
        state([
          ['task_a', 'passed', 'branch-a'],
          ['task_b', 'queued', 'branch-b'],
          ['task_c', 'queued', 'branch-c'],
          ['task_d', 'queued', 'branch-d'],
        ]),
      ).map(({ id }) => id),
    ).toEqual(['task_b', 'task_c']);

    expect(
      graph.readyTasks(
        state([
          ['task_a', 'passed', 'branch-a'],
          ['task_b', 'passed', 'branch-b'],
          ['task_c', 'running', 'branch-c'],
          ['task_d', 'queued', 'branch-d'],
        ]),
      ),
    ).toEqual([]);
  });

  test('never returns two writers for the same branch', () => {
    const graph = createTaskGraph({
      phases: [appendixCPlan.phases[0]],
      tasks: [task('task_a', 'phase_0'), task('task_b', 'phase_0')],
      budget: appendixCPlan.budget,
    });

    expect(
      graph.readyTasks(
        state([
          ['task_a', 'queued', 'shared-branch'],
          ['task_b', 'queued', 'shared-branch'],
        ]),
      ).map(({ id }) => id),
    ).toEqual(['task_a']);
  });

  test('does not schedule a queued writer onto an active branch', () => {
    const graph = createTaskGraph({
      phases: [appendixCPlan.phases[0]],
      tasks: [task('task_a', 'phase_0'), task('task_b', 'phase_0')],
      budget: appendixCPlan.budget,
    });

    expect(
      graph.readyTasks(
        state([
          ['task_a', 'running', 'shared-branch'],
          ['task_b', 'queued', 'shared-branch'],
        ]),
      ),
    ).toEqual([]);
  });

  test('keeps a branch reserved after a selected task becomes ready', () => {
    const graph = createTaskGraph({
      phases: [appendixCPlan.phases[0]],
      tasks: [task('task_a', 'phase_0'), task('task_b', 'phase_0')],
      budget: appendixCPlan.budget,
    });

    expect(
      graph.readyTasks(
        state([
          ['task_a', 'ready', 'shared-branch'],
          ['task_b', 'queued', 'shared-branch'],
        ]),
      ),
    ).toEqual([]);
  });
});
