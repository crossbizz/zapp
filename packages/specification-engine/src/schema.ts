import { createHash } from 'node:crypto';

import { z } from 'zod';

const SpecificationTextSchema = z.string().trim().min(1).max(20_000);
const SpecificationTextListSchema = z
  .array(SpecificationTextSchema)
  .min(1)
  .max(200);

export const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-[1-9][0-9]*$/u, 'Acceptance criterion ids must be AC-n.'),
    text: SpecificationTextSchema,
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    criticalFlow: z.boolean(),
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const SpecificationSchema = z
  .object({
    problem: SpecificationTextSchema,
    targetUsers: SpecificationTextListSchema,
    goals: SpecificationTextListSchema,
    nonGoals: SpecificationTextListSchema,
    journeys: SpecificationTextListSchema,
    pagesRoutes: SpecificationTextListSchema,
    rolesPermissions: SpecificationTextListSchema,
    dataModel: SpecificationTextListSchema,
    integrations: SpecificationTextListSchema,
    functionalRequirements: SpecificationTextListSchema,
    nonfunctionalRequirements: SpecificationTextListSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(200),
    assumptions: SpecificationTextListSchema,
    risks: SpecificationTextListSchema,
    definitionOfDone: SpecificationTextListSchema,
  })
  .strict();
export type Specification = z.infer<typeof SpecificationSchema>;

export const SpecificationContentEtagSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u);

export function specificationContentEtag(specificationValue: unknown): string {
  const specification = SpecificationSchema.parse(specificationValue);
  return SpecificationContentEtagSchema.parse(
    `sha256:${createHash('sha256').update(canonical(specification)).digest('hex')}`,
  );
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('specification_non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new Error('specification_non_json_value');
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(',')}}`;
}
