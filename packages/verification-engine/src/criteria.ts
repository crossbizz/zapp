import { z } from 'zod';

export const CriterionIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u, 'Invalid criterion id');

const IdentifierSchema = z.string().trim().min(1).max(1_024);
const UniqueIdentifiersSchema = z
  .array(IdentifierSchema)
  .max(10_000)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'criterion_duplicate_list_value' });
    }
  });

const CriterionSourceSchema = z
  .object({
    criterionId: CriterionIdSchema,
    verifierComments: z.array(z.string().trim().min(1).max(10_000)).max(1_000).optional(),
  })
  .strict();

const CriterionTaskSchema = z
  .object({
    taskId: IdentifierSchema,
    acceptanceCriteriaIds: z.array(CriterionIdSchema).min(1).max(1_000),
  })
  .strict();

export const CriterionTestCaseSchema = z
  .object({
    testCaseId: IdentifierSchema,
    name: z.string().trim().min(1).max(2_048),
    status: z.enum(['passed', 'failed', 'skipped']),
    evidenceArtifactIds: UniqueIdentifiersSchema,
  })
  .strict();
export type CriterionTestCase = z.infer<typeof CriterionTestCaseSchema>;

const CriterionWaiverSchema = z
  .object({
    criterionId: CriterionIdSchema,
    actorId: IdentifierSchema,
    reason: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const CriterionAssemblyInputSchema = z
  .object({
    specificationVersion: z.number().int().positive(),
    criteria: z.array(CriterionSourceSchema).min(1).max(1_000),
    tasks: z.array(CriterionTaskSchema).max(10_000),
    testCases: z.array(CriterionTestCaseSchema).max(100_000),
    waivers: z.array(CriterionWaiverSchema).max(1_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    for (const [path, values] of [
      ['criteria', input.criteria.map(({ criterionId }) => criterionId)],
      ['tasks', input.tasks.map(({ taskId }) => taskId)],
      ['testCases', input.testCases.map(({ testCaseId }) => testCaseId)],
      ['waivers', (input.waivers ?? []).map(({ criterionId }) => criterionId)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `criterion_duplicate_${path}`,
        });
      }
    }
  });
export type CriterionAssemblyInput = z.infer<typeof CriterionAssemblyInputSchema>;

export const CriterionRecordSchema = z
  .object({
    criterionId: CriterionIdSchema,
    specificationVersion: z.number().int().positive(),
    taskIds: UniqueIdentifiersSchema,
    testCaseIds: UniqueIdentifiersSchema,
    result: z.enum(['passed', 'failed', 'unverified', 'waived']),
    evidenceArtifactIds: UniqueIdentifiersSchema,
    verifierComments: z.array(z.string().trim().min(1).max(10_000)).max(1_000),
  })
  .strict();
export type CriterionRecord = z.infer<typeof CriterionRecordSchema>;

export const CriteriaCompletionReportSchema = z
  .object({
    criteria: z.array(CriterionRecordSchema).min(1),
    text: z.string().min(1),
  })
  .strict();
export type CriteriaCompletionReport = z.infer<typeof CriteriaCompletionReportSchema>;

const criterionTitlePattern = /^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\](?:\s|$)/u;

export function criterionIdFromTestTitle(title: string): string | undefined {
  const match = criterionTitlePattern.exec(title);
  if (match?.[1] === undefined) return undefined;
  return CriterionIdSchema.parse(match[1]);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function resultFor(
  cases: readonly z.infer<typeof CriterionTestCaseSchema>[],
  waived: boolean,
): CriterionRecord['result'] {
  if (cases.some(({ status }) => status === 'failed')) return 'failed';
  if (waived) return 'waived';
  if (cases.length === 0 || cases.some(({ status }) => status === 'skipped')) return 'unverified';
  return 'passed';
}

export function assembleCriterionRecords(input: unknown): CriterionRecord[] {
  const parsed = CriterionAssemblyInputSchema.parse(input);
  const criterionIds = new Set(parsed.criteria.map(({ criterionId }) => criterionId));

  for (const task of parsed.tasks) {
    for (const criterionId of task.acceptanceCriteriaIds) {
      if (!criterionIds.has(criterionId)) {
        throw new Error(`criterion_task_reference_missing:${criterionId}`);
      }
    }
  }

  const casesByCriterion = new Map<string, z.infer<typeof CriterionTestCaseSchema>[]>();
  for (const testCase of parsed.testCases) {
    const criterionId = criterionIdFromTestTitle(testCase.name);
    if (criterionId === undefined) continue;
    if (!criterionIds.has(criterionId)) {
      throw new Error(`criterion_test_reference_missing:${criterionId}`);
    }
    const cases = casesByCriterion.get(criterionId) ?? [];
    cases.push(testCase);
    casesByCriterion.set(criterionId, cases);
  }

  const waivers = new Map((parsed.waivers ?? []).map((waiver) => [waiver.criterionId, waiver]));
  for (const criterionId of waivers.keys()) {
    if (!criterionIds.has(criterionId)) {
      throw new Error(`criterion_waiver_reference_missing:${criterionId}`);
    }
  }

  return parsed.criteria.map((criterion) => {
    const cases = casesByCriterion.get(criterion.criterionId) ?? [];
    const waiver = waivers.get(criterion.criterionId);
    const comments = [...(criterion.verifierComments ?? [])];
    if (waiver !== undefined) {
      comments.push(`Waived by ${waiver.actorId}: ${waiver.reason}`);
    }
    return CriterionRecordSchema.parse({
      criterionId: criterion.criterionId,
      specificationVersion: parsed.specificationVersion,
      taskIds: uniqueSorted(
        parsed.tasks
          .filter(({ acceptanceCriteriaIds }) =>
            acceptanceCriteriaIds.includes(criterion.criterionId),
          )
          .map(({ taskId }) => taskId),
      ),
      testCaseIds: uniqueSorted(cases.map(({ testCaseId }) => testCaseId)),
      result: resultFor(cases, waiver !== undefined),
      evidenceArtifactIds: uniqueSorted(cases.flatMap(({ evidenceArtifactIds }) => evidenceArtifactIds)),
      verifierComments: comments,
    });
  });
}

function list(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

export function buildCriteriaCompletionReport(input: unknown): CriteriaCompletionReport {
  const criteria = assembleCriterionRecords(input);
  const specificationVersion = criteria[0]?.specificationVersion;
  if (specificationVersion === undefined) throw new Error('criterion_report_empty');
  const lines = criteria.map(
    (criterion) =>
      `- ${criterion.criterionId} | ${criterion.result} | tasks: ${list(criterion.taskIds)} | tests: ${list(criterion.testCaseIds)} | evidence: ${list(criterion.evidenceArtifactIds)} | comments: ${list(criterion.verifierComments)}`,
  );
  return CriteriaCompletionReportSchema.parse({
    criteria,
    text: [
      `Acceptance criteria (specification v${String(specificationVersion)}): ${String(criteria.length)} total`,
      ...lines,
    ].join('\n'),
  });
}
