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

const EslintMessageSchema = z
  .object({
    ruleId: z.string().nullable(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  })
  .passthrough();

const EslintOutputSchema = z
  .array(
    z
      .object({
        filePath: z.string().min(1).max(4_096),
        messages: z.array(EslintMessageSchema).max(5_000),
      })
      .passthrough(),
  )
  .max(10_000);

const EmptyCatchInputSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4_096),
    supportLevel: SupportLevelSchema,
  })
  .strict();

export async function detectEmptyCatches(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
}): Promise<PolicySignal[]> {
  const parsed = EmptyCatchInputSchema.parse({
    workspaceRoot: input.workspaceRoot,
    supportLevel: input.supportLevel,
  });
  const result = await executeAntiSlopTool(input.runtime, {
    cmd: 'eslint',
    args: ['.', '--format', 'json', '--rule', 'no-empty:error'],
    cwd: parsed.workspaceRoot,
    acceptedExitCodes: [0, 1],
  });
  const report = EslintOutputSchema.parse(parseJsonToolOutput(result.stdout, 'eslint'));
  const locations = report.flatMap(({ filePath, messages }) =>
    messages
      .filter(({ ruleId }) => ruleId === 'no-empty')
      .map(({ line, column }) => ({ path: filePath, line, column })),
  );
  return policySignal(
    'empty-catch',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'blocking',
      managed: 'blocking',
    }),
    locations,
    false,
  );
}
