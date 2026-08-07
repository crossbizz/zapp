import {
  RunModeSchema,
  TOOL_GROUPS,
  TOOL_NAMES,
  type ToolName,
} from '@zapp/contracts';
import { z } from 'zod';
import { ContentProvenanceSchema } from './injection.js';
import { COMMAND_DENY_PATTERNS, DESTRUCTIVE_SQL_PATTERNS } from './risk.js';

const READ_ONLY_TOOL_NAMES = new Set<ToolName>(TOOL_GROUPS.read);
const HIGH_RISK_POLICY_TOOL_NAMES = new Set<ToolName>([
  'execute_migration',
  'set_environment_variable',
]);
const HUMAN_APPROVAL_TOOL_NAMES = new Set<ToolName>(['deploy_release', 'rollback_release']);
const RELEASE_TOOL_NAMES = new Set<ToolName>(TOOL_GROUPS.release);

export const EnvironmentScopeSchema = z.enum(['preview', 'staging', 'production']);
export type EnvironmentScope = z.infer<typeof EnvironmentScopeSchema>;

const ReleaseIdSchema = z.string().min(1);
const DataDispositionSchema = z.enum(['preserve', 'transfer', 'reset']);

export const DeploymentApprovalSchema = z.discriminatedUnion('deploymentType', [
  z
    .object({
      releaseId: ReleaseIdSchema,
      deploymentType: z.literal('first_deploy'),
      dataDisposition: z.null(),
    })
    .strict(),
  z
    .object({
      releaseId: ReleaseIdSchema,
      deploymentType: z.literal('redeploy'),
      dataDisposition: z.null(),
    })
    .strict(),
  z
    .object({
      releaseId: ReleaseIdSchema,
      deploymentType: z.literal('replace_deployment'),
      dataDisposition: DataDispositionSchema,
    })
    .strict(),
]);

export type DeploymentApproval = z.infer<typeof DeploymentApprovalSchema>;

export const PolicyContextSchema = z
  .object({
    mode: RunModeSchema,
    provenance: z.array(ContentProvenanceSchema),
    environmentScope: EnvironmentScopeSchema.default('production'),
    approvedReleaseId: z.string().min(1).nullable(),
    approvedDeployment: DeploymentApprovalSchema.nullable().default(null),
  })
  .strict();

export type PolicyContext = z.input<typeof PolicyContextSchema>;

const ToolPolicyMetadataOutputSchema = z
  .object({
    name: z.enum(TOOL_NAMES),
    classification: z.enum(['read_only', 'mutating']),
    riskLevel: z.enum(['low', 'medium', 'high']),
    approvalPolicy: z.enum(['auto', 'policy', 'human']),
  })
  .strict();

function canonicalToolMetadata(name: ToolName): z.infer<typeof ToolPolicyMetadataOutputSchema> {
  const readOnly = READ_ONLY_TOOL_NAMES.has(name);
  return ToolPolicyMetadataOutputSchema.parse({
    name,
    classification: readOnly ? 'read_only' : 'mutating',
    riskLevel: readOnly
      ? 'low'
      : RELEASE_TOOL_NAMES.has(name) || HIGH_RISK_POLICY_TOOL_NAMES.has(name)
        ? 'high'
        : 'medium',
    approvalPolicy: readOnly
      ? 'auto'
      : HUMAN_APPROVAL_TOOL_NAMES.has(name)
        ? 'human'
        : 'policy',
  });
}

export const ToolPolicyMetadataSchema = z
  .enum(TOOL_NAMES)
  .transform((name) => canonicalToolMetadata(name));

export type ToolPolicyMetadata = z.infer<typeof ToolPolicyMetadataSchema>;

export const PolicyDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }).strict(),
  z
    .object({
      action: z.literal('require_approval'),
      reason: z.enum([
        'destructive_migration',
        'production_migration',
        'release_approval_required',
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal('deny'),
      reason: z.enum(['ask_mode_mutation', 'dangerous_command', 'untrusted_instruction']),
    })
    .strict(),
]);

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

const RunCommandPolicyInputSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

const ExecuteMigrationPolicyInputSchema = z
  .object({
    environmentId: z.string().min(1),
    migration: z.string().min(1),
  })
  .strict();

const DeployReleasePolicyInputSchema = z.discriminatedUnion('deploymentType', [
  z
    .object({
      releaseId: ReleaseIdSchema,
      deploymentType: z.literal('first_deploy'),
    })
    .strict(),
  z
    .object({
      releaseId: ReleaseIdSchema,
      deploymentType: z.literal('redeploy'),
    })
    .strict(),
  z
    .object({
      releaseId: ReleaseIdSchema,
      deploymentType: z.literal('replace_deployment'),
      dataDisposition: DataDispositionSchema,
    })
    .strict(),
]);

function canonicalDeployment(input: unknown): DeploymentApproval {
  const deployment = DeployReleasePolicyInputSchema.parse(input);
  return DeploymentApprovalSchema.parse({
    ...deployment,
    dataDisposition:
      deployment.deploymentType === 'replace_deployment'
        ? deployment.dataDisposition
        : null,
  });
}

function approvalMatchesDeployment(
  approval: DeploymentApproval | null,
  deployment: DeploymentApproval,
): boolean {
  return (
    approval !== null &&
    approval.releaseId === deployment.releaseId &&
    approval.deploymentType === deployment.deploymentType &&
    approval.dataDisposition === deployment.dataDisposition
  );
}

function allow(): PolicyDecision {
  return PolicyDecisionSchema.parse({ action: 'allow' });
}

function deny(reason: 'ask_mode_mutation' | 'dangerous_command' | 'untrusted_instruction'):
  PolicyDecision {
  return PolicyDecisionSchema.parse({ action: 'deny', reason });
}

function requireApproval(
  reason: 'destructive_migration' | 'production_migration' | 'release_approval_required',
): PolicyDecision {
  return PolicyDecisionSchema.parse({ action: 'require_approval', reason });
}

function hasUntrustedProvenance(context: PolicyContext): boolean {
  return context.provenance.some((provenance) => provenance.trust === 'untrusted');
}

function commandIsDenied(input: unknown): boolean {
  const command = RunCommandPolicyInputSchema.parse(input);
  const line = [command.cmd, ...command.args].join(' ');
  return COMMAND_DENY_PATTERNS.some((pattern) => pattern.test(line));
}

function migrationNeedsApproval(input: unknown): boolean {
  const { migration } = ExecuteMigrationPolicyInputSchema.parse(input);
  if (DESTRUCTIVE_SQL_PATTERNS.always.some((pattern) => pattern.test(migration))) return true;
  return (
    DESTRUCTIVE_SQL_PATTERNS.deleteFrom.test(migration) &&
    !DESTRUCTIVE_SQL_PATTERNS.where.test(migration)
  );
}

export function evaluateToolCall(
  context: PolicyContext,
  tool: ToolName,
  input: unknown,
): PolicyDecision {
  const policyContext = PolicyContextSchema.parse(context);
  const metadata = ToolPolicyMetadataSchema.parse(tool);
  const consequential = metadata.classification === 'mutating';

  if (consequential && policyContext.mode === 'ask') return deny('ask_mode_mutation');
  if (consequential && hasUntrustedProvenance(policyContext)) {
    return deny('untrusted_instruction');
  }
  if (metadata.name === 'run_command' && commandIsDenied(input)) {
    return deny('dangerous_command');
  }

  if (metadata.name === 'execute_migration') {
    if (migrationNeedsApproval(input)) return requireApproval('destructive_migration');
    if (policyContext.environmentScope === 'production') {
      return requireApproval('production_migration');
    }
  }
  if (metadata.name === 'deploy_release') {
    const deployment = canonicalDeployment(input);
    if (!approvalMatchesDeployment(policyContext.approvedDeployment, deployment)) {
      return requireApproval('release_approval_required');
    }
  }
  if (metadata.approvalPolicy === 'human' && metadata.name !== 'deploy_release') {
    return requireApproval('release_approval_required');
  }

  return allow();
}

export {
  ContentProvenanceSchema,
  WrappedUntrustedSchema,
  wrapUntrusted,
  type ContentProvenance,
  type WrappedUntrusted,
} from './injection.js';
export { PolicyBudgetSchema, type PolicyBudget } from './budgets.js';
