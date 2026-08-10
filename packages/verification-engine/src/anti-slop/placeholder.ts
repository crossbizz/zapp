import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { ExecResult, WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

const MAX_TOOL_OUTPUT_BYTES = 1_024 * 1_024;
const ANTI_SLOP_TOOL_TIMEOUT_MS = 300_000;
const MAX_POLICY_LOCATIONS = 2_000;

export const PolicySeveritySchema = z.enum(['blocking', 'human_review', 'warning']);
export type PolicySeverity = z.infer<typeof PolicySeveritySchema>;

export const PolicyLocationSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();
export type PolicyLocation = z.infer<typeof PolicyLocationSchema>;

export const PolicySignalIdSchema = z.enum([
  'placeholder',
  'todo',
  'duplicate',
  'unused-deps',
  'empty-catch',
  'disabled-tests',
  'diff-size',
  'mock-detect',
  'states-check',
]);
export type PolicySignalId = z.infer<typeof PolicySignalIdSchema>;

export const PolicySignalSchema = z
  .object({
    id: PolicySignalIdSchema,
    severity: PolicySeveritySchema,
    locations: z.array(PolicyLocationSchema).min(1).max(MAX_POLICY_LOCATIONS),
    autofixable: z.boolean(),
  })
  .strict();
export type PolicySignal = z.infer<typeof PolicySignalSchema>;

export const DiffRangeSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine(({ startLine, endLine }) => startLine <= endLine, 'anti_slop_invalid_diff_range');
export type DiffRange = z.infer<typeof DiffRangeSchema>;

const SemgrepOutputSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4_096),
            start: z
              .object({
                line: z.number().int().positive(),
                col: z.number().int().positive(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(MAX_POLICY_LOCATIONS),
    errors: z.array(z.unknown()).max(1_000).default([]),
  })
  .passthrough();

const PlaceholderInputSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4_096),
    supportLevel: SupportLevelSchema,
    releaseCriticalPaths: z.array(z.string().min(1).max(4_096)).max(500),
  })
  .strict();

export interface AntiSlopToolInput {
  readonly cmd: 'semgrep' | 'knip' | 'jscpd' | 'eslint';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly acceptedExitCodes: readonly number[];
}

export function severityByLevel(
  supportLevel: SupportLevel,
  values: Readonly<Record<SupportLevel, PolicySeverity>>,
): PolicySeverity {
  return values[supportLevel];
}

export function policySignal(
  id: PolicySignalId,
  severity: PolicySeverity,
  locations: readonly PolicyLocation[],
  autofixable: boolean,
): PolicySignal[] {
  const unique = uniqueLocations(locations);
  if (unique.length === 0) return [];
  return [PolicySignalSchema.parse({ id, severity, locations: unique, autofixable })];
}

export function uniqueLocations(locations: readonly PolicyLocation[]): PolicyLocation[] {
  const byKey = new Map<string, PolicyLocation>();
  for (const value of locations) {
    const location = PolicyLocationSchema.parse(value);
    const key = `${location.path}:${String(location.line ?? '')}:${String(location.column ?? '')}`;
    byKey.set(key, location);
  }
  return [...byKey.values()].slice(0, MAX_POLICY_LOCATIONS);
}

export function locationInRanges(location: PolicyLocation, ranges: readonly DiffRange[]): boolean {
  if (location.line === undefined) return false;
  return ranges.some(
    (range) =>
      range.path === location.path &&
      location.line !== undefined &&
      location.line >= range.startLine &&
      location.line <= range.endLine,
  );
}

export async function executeAntiSlopTool(
  runtime: WorkspaceRuntime,
  input: AntiSlopToolInput,
): Promise<ExecResult> {
  const result = await runtime.exec({
    cmd: input.cmd,
    args: [...input.args],
    cwd: input.cwd,
    timeoutMs: ANTI_SLOP_TOOL_TIMEOUT_MS,
  });
  if (
    result.truncated ||
    result.terminationReason !== undefined ||
    !input.acceptedExitCodes.includes(result.exitCode) ||
    Buffer.byteLength(result.stdout, 'utf8') > MAX_TOOL_OUTPUT_BYTES
  ) {
    throw new Error(`anti_slop_tool_failed:${input.cmd}`);
  }
  return result;
}

export function parseJsonToolOutput(output: string, tool: AntiSlopToolInput['cmd']): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`anti_slop_invalid_tool_output:${tool}`);
  }
}

export async function runSemgrepPatterns(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly patterns: readonly string[];
  readonly paths: readonly string[];
}): Promise<PolicyLocation[]> {
  if (input.paths.length === 0) return [];
  const locations: PolicyLocation[] = [];
  for (const pattern of input.patterns) {
    const result = await executeAntiSlopTool(input.runtime, {
      cmd: 'semgrep',
      args: [
        'scan',
        '--json',
        '--metrics',
        'off',
        '--lang',
        'generic',
        '--pattern',
        pattern,
        '--',
        ...input.paths,
      ],
      cwd: input.workspaceRoot,
      acceptedExitCodes: [0],
    });
    const parsed = SemgrepOutputSchema.parse(parseJsonToolOutput(result.stdout, 'semgrep'));
    if (parsed.errors.length > 0) throw new Error('anti_slop_semgrep_scan_error');
    locations.push(
      ...parsed.results.map(({ path, start }) => ({
        path,
        line: start.line,
        column: start.col,
      })),
    );
  }
  return uniqueLocations(locations);
}

export async function detectPlaceholderText(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
  readonly releaseCriticalPaths: readonly string[];
}): Promise<PolicySignal[]> {
  const parsed = PlaceholderInputSchema.parse({
    workspaceRoot: input.workspaceRoot,
    supportLevel: input.supportLevel,
    releaseCriticalPaths: input.releaseCriticalPaths,
  });
  const locations = await runSemgrepPatterns({
    runtime: input.runtime,
    workspaceRoot: parsed.workspaceRoot,
    patterns: ['lorem ipsum', 'TODO: implement', '<p>Placeholder'],
    paths: parsed.releaseCriticalPaths,
  });
  const criticalPaths = new Set(parsed.releaseCriticalPaths);
  return policySignal(
    'placeholder',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'blocking',
      managed: 'blocking',
    }),
    locations.filter(({ path }) => criticalPaths.has(path)),
    false,
  );
}
