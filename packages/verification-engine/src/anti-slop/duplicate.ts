import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

import {
  executeAntiSlopTool,
  policySignal,
  severityByLevel,
  type PolicyLocation,
  type PolicySignal,
} from './placeholder.js';

const DuplicateInputSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4_096),
    supportLevel: SupportLevelSchema,
  })
  .strict();

function parseCloneSide(value: string, fallbackPath?: string): PolicyLocation | undefined {
  const trimmed = value.trim();
  const withPath = /^(.*?)(?::|\s)(\d+)-(\d+)$/u.exec(trimmed);
  if (withPath?.[1] !== undefined && withPath[2] !== undefined) {
    return { path: withPath[1], line: Number(withPath[2]) };
  }
  const rangeOnly = /^(\d+)-(\d+)$/u.exec(trimmed);
  if (rangeOnly?.[1] !== undefined && fallbackPath !== undefined) {
    return { path: fallbackPath, line: Number(rangeOnly[1]) };
  }
  return undefined;
}

function parseJscpdAiOutput(output: string): PolicyLocation[] {
  const locations: PolicyLocation[] = [];
  let reportedCloneLines = 0;
  for (const line of output.split('\n')) {
    if (!line.includes('~')) continue;
    reportedCloneLines += 1;
    const [firstText, secondText] = line.split('~', 2);
    if (firstText === undefined || secondText === undefined) continue;
    const first = parseCloneSide(firstText);
    const second = parseCloneSide(secondText, first?.path);
    if (first !== undefined) locations.push(first);
    if (second !== undefined) locations.push(second);
  }
  if (reportedCloneLines > 0 && locations.length === 0) {
    throw new Error('anti_slop_invalid_tool_output:jscpd');
  }
  return locations;
}

export async function detectStructuralDuplicates(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
}): Promise<PolicySignal[]> {
  const parsed = DuplicateInputSchema.parse({
    workspaceRoot: input.workspaceRoot,
    supportLevel: input.supportLevel,
  });
  const result = await executeAntiSlopTool(input.runtime, {
    cmd: 'jscpd',
    args: ['--reporters', 'ai', '--min-lines', '5', '--min-tokens', '50', '.'],
    cwd: parsed.workspaceRoot,
    acceptedExitCodes: [0, 1],
  });
  return policySignal(
    'duplicate',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'warning',
      managed: 'warning',
    }),
    parseJscpdAiOutput(result.stdout),
    false,
  );
}
