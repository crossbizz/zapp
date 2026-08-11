import {
  CommitShaSchema,
  CompatibilityResultSchema,
  DeploymentPlanSchema,
  ExecutionContractSchema,
  SupportLevelSchema,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

const EnvironmentNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Z_][A-Z0-9_]*$/u);
const CheckResultSchema = z
  .object({
    commitSha: CommitShaSchema,
    status: z.enum(['passed', 'failed']),
    detail: z.string().trim().min(1).max(2_000),
  })
  .strict();
const CriticalBrowserFlowSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    status: z.enum(['passed', 'failed']),
    detail: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const ReadinessEvaluationInputSchema = z
  .object({
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    supportLevel: SupportLevelSchema,
    contract: ExecutionContractSchema,
    deploymentPlan: DeploymentPlanSchema,
    detectedEnvironmentReads: z.array(EnvironmentNameSchema).max(1_000),
    targetEnvironmentVariableNames: z.array(EnvironmentNameSchema).max(1_000),
    productionBuild: CheckResultSchema,
    productionStart: CheckResultSchema,
    lockfileConsistency: CheckResultSchema,
    database: z
      .object({
        required: z.boolean(),
        connectivity: z.enum(['passed', 'failed', 'not_applicable']),
        migrationValidation: z.enum(['passed', 'failed', 'not_applicable']),
        destructiveMigrationApproval: z.enum(['not_required', 'approved', 'missing']),
      })
      .strict(),
    providerCompatibility: CompatibilityResultSchema,
    criticalBrowserFlows: z
      .object({
        commitSha: CommitShaSchema,
        results: z.array(CriticalBrowserFlowSchema).min(1).max(1_000),
      })
      .strict(),
    verification: z
      .object({
        commitSha: CommitShaSchema,
        decision: z.enum(['approved', 'rejected', 'needs_human']),
        blockingRiskSummaries: z.array(z.string().trim().min(1).max(2_000)).max(1_000),
        warningRiskSummaries: z.array(z.string().trim().min(1).max(2_000)).max(1_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, context) => {
    const flowIds = input.criticalBrowserFlows.results.map(({ id }) => id);
    if (new Set(flowIds).size !== flowIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'readiness_duplicate_critical_flow',
        path: ['criticalBrowserFlows', 'results'],
      });
    }
  });
export type ReadinessEvaluationInput = z.infer<typeof ReadinessEvaluationInputSchema>;

export const ReadinessFindingSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    severity: z.enum(['blocker', 'warning']),
    title: z.string().trim().min(1).max(256),
    detail: z.string().trim().min(1).max(2_000),
    action: z.enum(['fix_and_recheck', 'review', 'waive']),
  })
  .strict();
export type ReadinessFinding = z.infer<typeof ReadinessFindingSchema>;

export const ReadinessReportSchema = z
  .object({
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    state: z.enum(['ready', 'warnings', 'blocked']),
    findings: z.array(ReadinessFindingSchema).max(2_000),
    blockers: z.array(z.string().trim().min(1).max(512)).max(2_000),
    primaryAction: z.literal('fix_and_recheck').nullable(),
  })
  .strict()
  .superRefine((report, context) => {
    const blockerIds = report.findings
      .filter(({ severity }) => severity === 'blocker')
      .map(({ id }) => id);
    if (JSON.stringify(blockerIds) !== JSON.stringify(report.blockers)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'readiness_blocker_list_mismatch' });
    }
    const expectedState =
      blockerIds.length > 0 ? 'blocked' : report.findings.length > 0 ? 'warnings' : 'ready';
    if (report.state !== expectedState) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'readiness_state_mismatch' });
    }
    if ((report.state === 'blocked') !== (report.primaryAction === 'fix_and_recheck')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'readiness_primary_action_mismatch' });
    }
  });
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

function finding(input: z.input<typeof ReadinessFindingSchema>): ReadinessFinding {
  return ReadinessFindingSchema.parse(input);
}

function blockedFinding(
  id: string,
  title: string,
  detail: string,
): ReadinessFinding {
  return finding({ id, severity: 'blocker', title, detail, action: 'fix_and_recheck' });
}

function riskDetail(summaries: readonly string[], fallback: string): string {
  return summaries.length === 0 ? fallback : summaries.join(' ');
}

/**
 * Combines the authoritative results produced by plans 05 and 06. This module does
 * not rerun provider or verifier work, so readiness always refers to one exact commit.
 */
export function evaluateReadiness(inputValue: unknown): ReadinessReport {
  const input = ReadinessEvaluationInputSchema.parse(inputValue);
  const findings: ReadinessFinding[] = [];

  if (
    input.contract.build === undefined ||
    input.productionBuild.status !== 'passed' ||
    input.productionBuild.commitSha !== input.commitSha
  ) {
    findings.push(
      blockedFinding(
        'production_build',
        'Production build failed',
        input.contract.build === undefined
          ? 'The execution contract does not define a production build command.'
          : input.productionBuild.commitSha !== input.commitSha
            ? 'The production-build result does not belong to the release commit.'
          : input.productionBuild.detail,
      ),
    );
  }
  if (
    input.contract.start === undefined ||
    input.productionStart.status !== 'passed' ||
    input.productionStart.commitSha !== input.commitSha
  ) {
    findings.push(
      blockedFinding(
        'production_start',
        'Production start failed',
        input.contract.start === undefined
          ? 'The execution contract does not define the command the deployed service must run.'
          : input.productionStart.commitSha !== input.commitSha
            ? 'The production-start result does not belong to the release commit.'
            : input.productionStart.detail,
      ),
    );
  }
  if (
    input.lockfileConsistency.status !== 'passed' ||
    input.lockfileConsistency.commitSha !== input.commitSha
  ) {
    findings.push(
      blockedFinding(
        'lockfile_consistency',
        'Lockfile is inconsistent',
        input.lockfileConsistency.commitSha !== input.commitSha
          ? 'The frozen-install result does not belong to the release commit.'
          : input.lockfileConsistency.detail,
      ),
    );
  }

  const requiredEnvironmentNames = new Set([
    ...input.deploymentPlan.requiredEnvVars,
    ...input.detectedEnvironmentReads,
  ]);
  const configuredEnvironmentNames = new Set(input.targetEnvironmentVariableNames);
  for (const name of [...requiredEnvironmentNames].sort()) {
    if (configuredEnvironmentNames.has(name)) continue;
    const managed = input.supportLevel === 'managed';
    findings.push(
      finding({
        id: `missing_environment:${name}`,
        severity: managed ? 'blocker' : 'warning',
        title: 'Environment value missing',
        detail: `${name} is required by the contract or source but is not configured in the target environment.`,
        action: managed ? 'fix_and_recheck' : 'review',
      }),
    );
  }

  if (
    input.database.connectivity === 'failed' ||
    (input.database.required && input.database.connectivity !== 'passed')
  ) {
    findings.push(
      blockedFinding(
        'database_connectivity',
        'Database connection failed',
        'The target database did not pass its connectivity check.',
      ),
    );
  }
  if (
    input.database.migrationValidation === 'failed' ||
    (input.database.required && input.database.migrationValidation !== 'passed')
  ) {
    findings.push(
      blockedFinding(
        'migration_validation',
        'Migration validation failed',
        'Pending migrations did not pass the isolated validation and smoke checks.',
      ),
    );
  }
  if (input.database.destructiveMigrationApproval === 'missing') {
    findings.push(
      blockedFinding(
        'migration_approval',
        'Migration approval missing',
        'A destructive migration is present without its required approval record.',
      ),
    );
  }

  if (
    input.providerCompatibility.providerId !== input.deploymentPlan.providerId ||
    !input.providerCompatibility.compatible
  ) {
    findings.push(
      blockedFinding(
        'provider_compatibility',
        'Deployment provider is incompatible',
        input.providerCompatibility.reasons.length === 0
          ? 'The selected deployment provider did not accept this project contract.'
          : input.providerCompatibility.reasons.join(' '),
      ),
    );
  }
  if (input.contract.health === undefined) {
    findings.push(
      blockedFinding(
        'health_endpoint',
        'Health endpoint missing',
        'The execution contract does not define a production health endpoint.',
      ),
    );
  }

  if (input.criticalBrowserFlows.commitSha !== input.commitSha) {
    findings.push(
      blockedFinding(
        'critical_browser_flow_commit',
        'Critical-flow evidence is stale',
        'The latest critical browser-flow results do not belong to the release commit.',
      ),
    );
  } else {
    for (const result of input.criticalBrowserFlows.results) {
      if (result.status === 'failed') {
        findings.push(
          blockedFinding(
            `critical_browser_flow:${result.id}`,
            'Critical browser flow failed',
            result.detail,
          ),
        );
      }
    }
  }

  if (input.verification.commitSha !== input.commitSha) {
    findings.push(
      blockedFinding(
        'release_policy_commit',
        'Release-policy evidence is stale',
        'The VF-10 verifier decision does not belong to the release commit.',
      ),
    );
  }
  if (input.verification.decision === 'rejected') {
    findings.push(
      blockedFinding(
        'release_policy',
        'Release policy rejected the commit',
        riskDetail(
          input.verification.blockingRiskSummaries,
          'The VF-10 verifier rejected this commit for release.',
        ),
      ),
    );
  } else if (input.verification.decision === 'needs_human') {
    findings.push(
      finding({
        id: 'release_policy',
        severity: 'warning',
        title: 'Release policy needs review',
        detail: riskDetail(
          input.verification.warningRiskSummaries,
          'The VF-10 verifier requires a human release review.',
        ),
        action: 'review',
      }),
    );
  }

  const blockers = findings
    .filter(({ severity }) => severity === 'blocker')
    .map(({ id }) => id);
  return ReadinessReportSchema.parse({
    releaseId: input.releaseId,
    commitSha: input.commitSha,
    state: blockers.length > 0 ? 'blocked' : findings.length > 0 ? 'warnings' : 'ready',
    findings,
    blockers,
    primaryAction: blockers.length > 0 ? 'fix_and_recheck' : null,
  });
}

export interface ReadinessFixRunPort {
  startFixRun(input: {
    readonly releaseId: string;
    readonly commitSha: string;
    readonly findingIds: readonly string[];
    readonly operationKey: string;
  }): Promise<unknown>;
}

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const FixAndRecheckInputSchema = z
  .object({ report: ReadinessReportSchema, operationKey: OperationKeySchema })
  .strict();
const FixRunResultSchema = z.object({ runId: idSchema('run') }).strict();
export type FixRunResult = z.infer<typeof FixRunResultSchema>;

/** Adapter boundary for the blocked report's primary AR-19 action. */
export async function fixAndRecheck(
  inputValue: unknown,
  fixRuns: ReadinessFixRunPort,
): Promise<FixRunResult> {
  const input = FixAndRecheckInputSchema.parse(inputValue);
  if (input.report.state !== 'blocked' || input.report.primaryAction !== 'fix_and_recheck') {
    throw new Error('readiness_fix_not_available');
  }
  return FixRunResultSchema.parse(
    await fixRuns.startFixRun({
      releaseId: input.report.releaseId,
      commitSha: input.report.commitSha,
      findingIds: input.report.blockers,
      operationKey: input.operationKey,
    }),
  );
}
