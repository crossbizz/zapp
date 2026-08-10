import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

import {
  executeAntiSlopTool,
  parseJsonToolOutput,
  policySignal,
  severityByLevel,
  type PolicySignal,
} from './placeholder.js';

const KnipDependencySchema = z
  .object({
    name: z.string().min(1).max(1_024),
    line: z.number().int().positive().optional(),
    col: z.number().int().positive().optional(),
  })
  .passthrough();

const KnipOutputSchema = z
  .object({
    issues: z
      .array(
        z
          .object({
            file: z.string().min(1).max(4_096),
            dependencies: z.array(KnipDependencySchema).max(2_000).default([]),
          })
          .passthrough(),
      )
      .max(5_000),
  })
  .passthrough();

const UnusedDepsInputSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4_096),
    supportLevel: SupportLevelSchema,
  })
  .strict();

export async function detectUnusedDependencies(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
}): Promise<PolicySignal[]> {
  const parsed = UnusedDepsInputSchema.parse({
    workspaceRoot: input.workspaceRoot,
    supportLevel: input.supportLevel,
  });
  const result = await executeAntiSlopTool(input.runtime, {
    cmd: 'knip',
    args: ['--reporter', 'json', '--include', 'dependencies'],
    cwd: parsed.workspaceRoot,
    acceptedExitCodes: [0, 1],
  });
  const report = KnipOutputSchema.parse(parseJsonToolOutput(result.stdout, 'knip'));
  const locations = report.issues.flatMap(({ file, dependencies }) =>
    dependencies.map(({ line, col }) => ({
      path: file,
      ...(line === undefined ? {} : { line }),
      ...(col === undefined ? {} : { column: col }),
    })),
  );
  return policySignal(
    'unused-deps',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'warning',
      managed: 'blocking',
    }),
    locations,
    true,
  );
}
