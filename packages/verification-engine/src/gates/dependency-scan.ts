import { idSchema } from '@zapp/contracts';
import type { ExecResult, FileEntry } from '@zapp/workspace-runtime';
import { z } from 'zod';

import { GateResultSchema, type Gate, type GateContext, type GateResult } from './registry.js';
import { DEFAULT_GATE_TIMEOUT_MS, notApplicable } from './shared.js';

const CRITICAL_CVSS_SCORE = 9;

const DependencyVulnerabilityIdSchema = z.string().trim().min(1).max(200);

export const DependencyVulnerabilityWaiverSchema = z
  .object({
    vulnerabilityId: DependencyVulnerabilityIdSchema,
    actorId: idSchema('user'),
    reason: z.string().trim().min(1).max(2_000),
    createdAt: z.string().datetime(),
  })
  .strict();
export type DependencyVulnerabilityWaiver = z.infer<
  typeof DependencyVulnerabilityWaiverSchema
>;

export const DependencyScanPolicySchema = z
  .object({
    waivers: z.array(DependencyVulnerabilityWaiverSchema).max(10_000),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = policy.waivers.map(({ vulnerabilityId }) => vulnerabilityId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dependency_scan_duplicate_waiver',
      });
    }
  });
export type DependencyScanPolicy = z.infer<typeof DependencyScanPolicySchema>;

const OsvPackageIdentitySchema = z
  .object({
    name: z.string().min(1).max(1_000),
    version: z.string().min(1).max(1_000),
    ecosystem: z.string().min(1).max(200),
  })
  .passthrough();

const OsvVulnerabilitySchema = z
  .object({ id: DependencyVulnerabilityIdSchema })
  .passthrough();

const OsvGroupSchema = z
  .object({
    ids: z.array(DependencyVulnerabilityIdSchema).min(1).max(1_000),
    max_severity: z.string().optional(),
  })
  .passthrough();

const OsvPackageResultSchema = z
  .object({
    package: OsvPackageIdentitySchema,
    vulnerabilities: z.array(OsvVulnerabilitySchema).max(10_000).default([]),
    groups: z.array(OsvGroupSchema).max(10_000).default([]),
  })
  .passthrough();

const OsvOutputSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            packages: z.array(OsvPackageResultSchema).max(100_000),
          })
          .passthrough(),
      )
      .max(100_000),
  })
  .passthrough();

const LOCKFILES_BY_PACKAGE_MANAGER = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
} as const;

interface NormalizedFinding {
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly ecosystem: string;
  };
  readonly ids: readonly string[];
  readonly maxSeverity: number | null;
  readonly critical: boolean;
  readonly waiver?: DependencyVulnerabilityWaiver;
}

function normalizedPath(path: string): string {
  return path.replace(/^\.\//, '');
}

function detectLockfile(contract: GateContext['contract'], files: readonly FileEntry[]): string | null {
  const present = new Set(
    files.filter(({ type }) => type === 'file').map(({ path }) => normalizedPath(path)),
  );
  return (
    LOCKFILES_BY_PACKAGE_MANAGER[contract.package_manager].find((candidate) =>
      present.has(candidate),
    ) ?? null
  );
}

function severityScore(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

function normalizeFindings(
  outputValue: unknown,
  waivers: ReadonlyMap<string, DependencyVulnerabilityWaiver>,
): NormalizedFinding[] {
  const output = OsvOutputSchema.parse(outputValue);
  const findings: NormalizedFinding[] = [];
  for (const result of output.results) {
    for (const packageResult of result.packages) {
      const groups =
        packageResult.groups.length > 0
          ? packageResult.groups
          : packageResult.vulnerabilities.map(({ id }) => ({ ids: [id] }));
      for (const group of groups) {
        const ids = [...new Set(group.ids)].sort();
        const rawSeverity = 'max_severity' in group ? group.max_severity : undefined;
        const score = severityScore(typeof rawSeverity === 'string' ? rawSeverity : undefined);
        const waiver = ids.map((id) => waivers.get(id)).find((entry) => entry !== undefined);
        findings.push({
          package: {
            name: packageResult.package.name,
            version: packageResult.package.version,
            ecosystem: packageResult.package.ecosystem,
          },
          ids,
          maxSeverity: score,
          critical: score !== null && score >= CRITICAL_CVSS_SCORE,
          ...(waiver === undefined ? {} : { waiver }),
        });
      }
    }
  }
  return findings;
}

function commandFor(lockfile: string): string {
  return [
    'set -eu',
    'config="$(mktemp)"',
    "trap 'rm -f \"$config\"' EXIT",
    ': > "$config"',
    `osv-scanner scan source --offline --format=json --config="$config" --lockfile=${lockfile}`,
  ].join('; ');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function scannerFailure(
  ctx: GateContext,
  input: {
    readonly lockfile?: string;
    readonly reason: 'dependency_lockfile_discovery_failed' | 'dependency_scanner_failed' | 'dependency_scanner_output_invalid';
    readonly result?: ExecResult;
    readonly error?: unknown;
  },
): Promise<GateResult> {
  const artifactId = await ctx.artifacts.store({
    kind: 'dependency_scan',
    body: new TextEncoder().encode(
      JSON.stringify({
        reason: input.reason,
        lockfile: input.lockfile,
        exitCode: input.result?.exitCode,
        stderr: input.result?.stderr,
        durationMs: input.result?.durationMs,
        truncated: input.result?.truncated,
        terminationReason: input.result?.terminationReason,
        error: input.error === undefined ? undefined : errorText(input.error),
      }),
    ),
  });
  return GateResultSchema.parse({
    status: 'failed',
    evidenceArtifactIds: [artifactId],
    details: { reason: input.reason, ...(input.lockfile === undefined ? {} : { lockfile: input.lockfile }) },
  });
}

export function createDependencyScanGate(
  policyValue: unknown = { waivers: [] },
): Gate {
  const policy = DependencyScanPolicySchema.parse(policyValue);
  const waivers = new Map(policy.waivers.map((waiver) => [waiver.vulnerabilityId, waiver]));
  return {
    id: 'dependency_scan',
    async run(ctx) {
      let files: FileEntry[];
      try {
        files = await ctx.runtime.listFiles(ctx.contract.workspace_root, { maxDepth: 0 });
      } catch (error) {
        return scannerFailure(ctx, {
          reason: 'dependency_lockfile_discovery_failed',
          error,
        });
      }
      const lockfile = detectLockfile(ctx.contract, files);
      if (lockfile === null) return notApplicable('dependency_lockfile_absent');

      const result = await ctx.runtime.exec({
        cmd: 'sh',
        args: ['-lc', commandFor(lockfile)],
        cwd: ctx.contract.workspace_root,
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
      });
      if (
        (result.exitCode !== 0 && result.exitCode !== 1) ||
        result.truncated ||
        result.terminationReason !== undefined
      ) {
        return scannerFailure(ctx, {
          lockfile,
          reason: 'dependency_scanner_failed',
          result,
        });
      }

      let findings: NormalizedFinding[];
      try {
        findings = normalizeFindings(JSON.parse(result.stdout) as unknown, waivers);
      } catch (error) {
        return scannerFailure(ctx, {
          lockfile,
          reason: 'dependency_scanner_output_invalid',
          result,
          error,
        });
      }

      const criticalFindings = findings.filter(({ critical }) => critical);
      const waivedCriticalFindings = criticalFindings.filter(({ waiver }) => waiver !== undefined);
      const artifactId = await ctx.artifacts.store({
        kind: 'dependency_scan',
        body: new TextEncoder().encode(
          JSON.stringify({
            lockfile,
            exitCode: result.exitCode,
            stderr: result.stderr,
            durationMs: result.durationMs,
            findings,
          }),
        ),
      });
      return GateResultSchema.parse({
        status:
          criticalFindings.length === waivedCriticalFindings.length ? 'passed' : 'failed',
        evidenceArtifactIds: [artifactId],
        details: {
          lockfile,
          findingCount: findings.length,
          criticalCount: criticalFindings.length,
          waivedCriticalCount: waivedCriticalFindings.length,
        },
      });
    },
  };
}
