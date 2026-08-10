import { describe, expect, test } from 'vitest';

import {
  assembleCriterionRecords,
  buildCriteriaCompletionReport,
  criterionIdFromTestTitle,
} from '../src/index.js';

const traceabilityInput = {
  specificationVersion: 7,
  criteria: [
    { criterionId: 'AC-1' },
    { criterionId: 'AC-2', verifierComments: ['Regression reproduced in Chromium.'] },
    { criterionId: 'AC-3' },
    { criterionId: 'AC-4' },
  ],
  tasks: [
    { taskId: 'TASK-1', acceptanceCriteriaIds: ['AC-1', 'AC-2'] },
    { taskId: 'TASK-2', acceptanceCriteriaIds: ['AC-2', 'AC-3'] },
  ],
  testCases: [
    {
      testCaseId: 'tcase_01',
      name: '[AC-1] saves the profile',
      status: 'passed',
      evidenceArtifactIds: ['art_01'],
    },
    {
      testCaseId: 'tcase_02',
      name: '[AC-2] opens the settings form',
      status: 'passed',
      evidenceArtifactIds: ['art_02'],
    },
    {
      testCaseId: 'tcase_03',
      name: '[AC-2] persists changed settings',
      status: 'failed',
      evidenceArtifactIds: ['art_03', 'art_02'],
    },
    {
      testCaseId: 'tcase_support',
      name: 'supporting smoke test',
      status: 'passed',
      evidenceArtifactIds: [],
    },
  ],
  waivers: [
    {
      criterionId: 'AC-4',
      actorId: 'user_01K1J6G0V8ZQ5Y7J3X9M2N4P6R',
      reason: 'The upstream test environment is unavailable under incident INC-42.',
    },
  ],
} as const;

describe('VF-9 acceptance-criteria traceability', () => {
  test('joins the specification criteria to plan tasks and annotated test results', () => {
    expect(assembleCriterionRecords(traceabilityInput)).toEqual([
      {
        criterionId: 'AC-1',
        specificationVersion: 7,
        taskIds: ['TASK-1'],
        testCaseIds: ['tcase_01'],
        result: 'passed',
        evidenceArtifactIds: ['art_01'],
        verifierComments: [],
      },
      {
        criterionId: 'AC-2',
        specificationVersion: 7,
        taskIds: ['TASK-1', 'TASK-2'],
        testCaseIds: ['tcase_02', 'tcase_03'],
        result: 'failed',
        evidenceArtifactIds: ['art_02', 'art_03'],
        verifierComments: ['Regression reproduced in Chromium.'],
      },
      {
        criterionId: 'AC-3',
        specificationVersion: 7,
        taskIds: ['TASK-2'],
        testCaseIds: [],
        result: 'unverified',
        evidenceArtifactIds: [],
        verifierComments: [],
      },
      {
        criterionId: 'AC-4',
        specificationVersion: 7,
        taskIds: [],
        testCaseIds: [],
        result: 'waived',
        evidenceArtifactIds: [],
        verifierComments: [
          'Waived by user_01K1J6G0V8ZQ5Y7J3X9M2N4P6R: The upstream test environment is unavailable under incident INC-42.',
        ],
      },
    ]);
  });

  test('always includes failed and unverified criteria in the completion report', () => {
    const report = buildCriteriaCompletionReport(traceabilityInput);

    expect(report.criteria).toHaveLength(4);
    expect(report.text).toContain('AC-2 | failed');
    expect(report.text).toContain('AC-3 | unverified');
    expect(report.text).toMatchInlineSnapshot(`
      "Acceptance criteria (specification v7): 4 total
      - AC-1 | passed | tasks: TASK-1 | tests: tcase_01 | evidence: art_01 | comments: none
      - AC-2 | failed | tasks: TASK-1, TASK-2 | tests: tcase_02, tcase_03 | evidence: art_02, art_03 | comments: Regression reproduced in Chromium.
      - AC-3 | unverified | tasks: TASK-2 | tests: none | evidence: none | comments: none
      - AC-4 | waived | tasks: none | tests: none | evidence: none | comments: Waived by user_01K1J6G0V8ZQ5Y7J3X9M2N4P6R: The upstream test environment is unavailable under incident INC-42."
    `);
  });

  test('parses only an exact leading criterion annotation from a generated test title', () => {
    expect(criterionIdFromTestTitle('[AC-3] saves settings')).toBe('AC-3');
    expect(criterionIdFromTestTitle('nested [AC-3] label')).toBeUndefined();
    expect(criterionIdFromTestTitle('[not-a-criterion] label')).toBeUndefined();
  });

  test('rejects task and test references to criteria missing from the specification', () => {
    expect(() =>
      assembleCriterionRecords({
        ...traceabilityInput,
        tasks: [{ taskId: 'TASK-9', acceptanceCriteriaIds: ['AC-99'] }],
      }),
    ).toThrow('criterion_task_reference_missing:AC-99');

    expect(() =>
      assembleCriterionRecords({
        ...traceabilityInput,
        testCases: [
          {
            testCaseId: 'tcase_99',
            name: '[AC-99] unknown criterion',
            status: 'passed',
            evidenceArtifactIds: [],
          },
        ],
      }),
    ).toThrow('criterion_test_reference_missing:AC-99');
  });
});
