import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

import {
  DiffRangeSchema,
  locationInRanges,
  policySignal,
  runSemgrepPatterns,
  severityByLevel,
  type PolicySignal,
} from './placeholder.js';

const IntroducedTodoInputSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4_096),
    supportLevel: SupportLevelSchema,
    requiredFeatureRanges: z.array(DiffRangeSchema).max(2_000),
  })
  .strict();

export async function detectIntroducedTodos(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
  readonly requiredFeatureRanges: readonly z.infer<typeof DiffRangeSchema>[];
}): Promise<PolicySignal[]> {
  const parsed = IntroducedTodoInputSchema.parse({
    workspaceRoot: input.workspaceRoot,
    supportLevel: input.supportLevel,
    requiredFeatureRanges: input.requiredFeatureRanges,
  });
  const locations = await runSemgrepPatterns({
    runtime: input.runtime,
    workspaceRoot: parsed.workspaceRoot,
    patterns: ['TODO', 'FIXME'],
    paths: [...new Set(parsed.requiredFeatureRanges.map(({ path }) => path))],
  });
  return policySignal(
    'todo',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'warning',
      managed: 'blocking',
    }),
    locations.filter((location) => locationInRanges(location, parsed.requiredFeatureRanges)),
    false,
  );
}
