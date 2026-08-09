import type { ExecResult } from '@zapp/workspace-runtime';

import { GateResultSchema, type GateContext, type GateResult } from './registry.js';

export const DEFAULT_GATE_TIMEOUT_MS = 300_000;

export function notApplicable(reason: string): GateResult {
  return GateResultSchema.parse({
    status: 'not_applicable',
    evidenceArtifactIds: [],
    details: { reason },
  });
}

export async function executeGateCommand(
  ctx: GateContext,
  input: {
    readonly artifactKind: string;
    readonly command: string;
    readonly timeoutMs: number;
    readonly summarize: (result: ExecResult) => Readonly<Record<string, unknown>>;
  },
): Promise<GateResult> {
  const result = await ctx.runtime.exec({
    cmd: 'sh',
    args: ['-lc', input.command],
    cwd: ctx.contract.workspace_root,
    timeoutMs: input.timeoutMs,
  });
  const summary = input.summarize(result);
  const artifactId = await ctx.artifacts.store({
    kind: input.artifactKind,
    body: new TextEncoder().encode(
      JSON.stringify({
        command: input.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        truncated: result.truncated,
        terminationReason: result.terminationReason,
        summary,
      }),
    ),
  });
  return GateResultSchema.parse({
    status: result.exitCode === 0 ? 'passed' : 'failed',
    evidenceArtifactIds: [artifactId],
    details: summary,
  });
}
