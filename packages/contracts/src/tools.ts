import { z } from 'zod';

/**
 * PRD §16.1, grouped and in order. Both the membership and the order are
 * contractual: the agent runtime (plan 04) registers exactly these tools and the
 * approval policy engine keys off the group a tool belongs to.
 */
export const TOOL_GROUPS = {
  read: [
    'read_file',
    'list_files',
    'file_stats',
    'search_code',
    'grep',
    'git_status',
    'git_diff',
    'git_log',
    'git_show',
    'read_logs',
    'read_test_results',
    'read_database_schema',
    'read_project_contract',
  ],
  mutation: [
    'write_file',
    'apply_patch',
    'copy_file',
    'rename_file',
    'delete_file',
    'install_dependency',
    'execute_migration',
    'set_environment_variable',
  ],
  execution: [
    'run_command',
    'run_dev_server',
    'restart_dev_server',
    'run_build',
    'run_typecheck',
    'run_lint',
    'run_unit_tests',
    'run_integration_tests',
    'run_browser_tests',
    'capture_screenshot',
    'inspect_browser_console',
    'inspect_network_requests',
  ],
  git: [
    'create_branch',
    'create_checkpoint',
    'commit_changes',
    'restore_file',
    'revert_commit',
    'merge_branch',
  ],
  release: [
    'create_preview',
    'run_preview_smoke_test',
    'create_release_candidate',
    'deploy_release',
    'check_deployment_health',
    'rollback_release',
  ],
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

/**
 * The 45 P0 tools as one flat list, in group order. Derived from `TOOL_GROUPS` so
 * the two can never disagree; the literal both must match is pinned in the tests.
 */
export const TOOL_NAMES = [
  ...TOOL_GROUPS.read,
  ...TOOL_GROUPS.mutation,
  ...TOOL_GROUPS.execution,
  ...TOOL_GROUPS.git,
  ...TOOL_GROUPS.release,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** PRD §16.2. Mutating tools touch the workspace, a database or a provider. */
export const ToolClassificationSchema = z.enum(['read_only', 'mutating']);

export type ToolClassification = z.infer<typeof ToolClassificationSchema>;

/** PRD §16.2 "Risk level" — the blast radius if the call is wrong. */
export const ToolRiskLevelSchema = z.enum(['low', 'medium', 'high']);

export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;

/**
 * PRD §16.2 "Required approval policy": run it (`auto`), ask the project's policy
 * engine (`policy`), or always stop for a person (`human`).
 */
export const ToolApprovalPolicySchema = z.enum(['auto', 'policy', 'human']);

export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicySchema>;

/** PRD §16.2 "Retry policy". `maxAttempts` counts the first call, so 1 means no retry. */
export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  backoffMs: z.number().int().nonnegative(),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * PRD §16.2. One tool as the agent runtime (plan 04) registers it: schemas for
 * both directions plus the safety metadata the orchestrator needs before it can
 * decide whether the call may run at all.
 */
export interface ToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  /** Restricted to the PRD §16.1 set: a new tool is a contract change, not a service detail. */
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly classification: ToolClassification;
  readonly riskLevel: ToolRiskLevel;
  readonly approvalPolicy: ToolApprovalPolicy;
  /** True when repeating an identical call leaves the workspace in the same state. */
  readonly idempotent: boolean;
  readonly timeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  /** True when the output may contain secret material and must be scrubbed before storage (PRD §16.3). */
  readonly redactOutput: boolean;
  /** One line for the user's timeline — never raw output, never a promise the call didn't keep. */
  userSummary(input: z.infer<I>, output: z.infer<O>): string;
}
