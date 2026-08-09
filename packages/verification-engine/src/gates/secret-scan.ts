import { z } from 'zod';

import { GateResultSchema, type Gate } from './registry.js';
import { DEFAULT_GATE_TIMEOUT_MS } from './shared.js';

const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const GitleaksFindingSchema = z
  .object({
    Description: z.string().optional(),
    StartLine: z.number().int().positive(),
    EndLine: z.number().int().positive().optional(),
    StartColumn: z.number().int().positive().optional(),
    EndColumn: z.number().int().positive().optional(),
    Match: z.string().optional(),
    Secret: z.string().optional(),
    File: z.string().min(1),
    Link: z.string().optional(),
    SymlinkFile: z.string().optional(),
    Commit: z.string().optional(),
    Entropy: z.number().optional(),
    Author: z.string().optional(),
    Email: z.string().optional(),
    Date: z.string().optional(),
    Message: z.string().optional(),
    Tags: z.array(z.string()).nullable().optional(),
    RuleID: z.string().min(1),
    Fingerprint: z.string().optional(),
  })
  .strict();
const GitleaksReportSchema = z.array(GitleaksFindingSchema);

function scanCommand(logOptions: string): string {
  return [
    'set -eu',
    'report=$(mktemp)',
    'trap \'rm -f "$report"\' EXIT INT TERM',
    'set +e',
    `gitleaks git --no-banner --log-level=error --redact=100 --report-format=json --report-path="$report" --log-opts=${logOptions} .`,
    'status=$?',
    'set -e',
    'if test -s "$report"; then cat "$report"; else printf \'[]\'; fi',
    'exit "$status"',
  ].join('; ');
}

export function createSecretScanGate(): Gate {
  return {
    id: 'secret_scan',
    async run(ctx) {
      const base = CommitSchema.parse(ctx.baseCommit);
      const head = CommitSchema.parse(ctx.commit);
      const result = await ctx.runtime.exec({
        cmd: 'sh',
        args: ['-lc', scanCommand(ctx.fullSecretScan ? '--all' : `${base}..${head}`)],
        cwd: ctx.contract.workspace_root,
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
      });
      const report = GitleaksReportSchema.parse(JSON.parse(result.stdout) as unknown);
      const findings = report.map((finding) => ({
        ruleId: finding.RuleID,
        file: finding.File,
        line: finding.StartLine,
      }));
      const artifactId = await ctx.artifacts.store({
        kind: 'verification.secret_scan',
        body: new TextEncoder().encode(
          JSON.stringify({
            exitCode: result.exitCode,
            findings,
            stderr: result.stderr,
            durationMs: result.durationMs,
            truncated: result.truncated,
          }),
        ),
      });
      return GateResultSchema.parse({
        status: result.exitCode === 0 && findings.length === 0 ? 'passed' : 'failed',
        evidenceArtifactIds: [artifactId],
        details: { findings },
      });
    },
  };
}
