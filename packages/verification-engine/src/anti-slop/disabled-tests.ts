import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

import {
  DiffRangeSchema,
  PolicyLocationSchema,
  locationInRanges,
  policySignal,
  runSemgrepPatterns,
  severityByLevel,
  type PolicySignal,
} from './placeholder.js';

const DisabledTestsInputSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4_096),
    supportLevel: SupportLevelSchema,
    introducedTestRanges: z.array(DiffRangeSchema).max(2_000),
    waivers: z.array(PolicyLocationSchema).max(2_000),
  })
  .strict();

function waiverMatches(
  location: z.infer<typeof PolicyLocationSchema>,
  waiver: z.infer<typeof PolicyLocationSchema>,
): boolean {
  return (
    location.path === waiver.path &&
    (waiver.line === undefined || location.line === waiver.line) &&
    (waiver.column === undefined || location.column === waiver.column)
  );
}

export async function detectDisabledTests(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
  readonly introducedTestRanges: readonly z.infer<typeof DiffRangeSchema>[];
  readonly waivers: readonly z.infer<typeof PolicyLocationSchema>[];
}): Promise<PolicySignal[]> {
  const parsed = DisabledTestsInputSchema.parse({
    workspaceRoot: input.workspaceRoot,
    supportLevel: input.supportLevel,
    introducedTestRanges: input.introducedTestRanges,
    waivers: input.waivers,
  });
  const locations = await runSemgrepPatterns({
    runtime: input.runtime,
    workspaceRoot: parsed.workspaceRoot,
    patterns: ['.skip', 'xit'],
    paths: [...new Set(parsed.introducedTestRanges.map(({ path }) => path))],
  });
  const unwaived = locations.filter(
    (location) =>
      locationInRanges(location, parsed.introducedTestRanges) &&
      !parsed.waivers.some((waiver) => waiverMatches(location, waiver)),
  );
  return policySignal(
    'disabled-tests',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'blocking',
      managed: 'blocking',
    }),
    unwaived,
    false,
  );
}
