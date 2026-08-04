import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TOOL_GROUPS,
  TOOL_NAMES,
  ToolApprovalPolicySchema,
  ToolClassificationSchema,
  ToolRiskLevelSchema,
  RetryPolicySchema,
  type ToolDefinition,
  type ToolName,
} from '../src/tools.js';

// Every list below is written out rather than derived from the source: the literal
// is the contract, so adding, dropping, renaming or reordering a tool has to fail
// here first.

describe('TOOL_NAMES', () => {
  it('is exactly the PRD §16.1 tool set, in order', () => {
    expect(TOOL_NAMES).toEqual([
      // read
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
      // mutation
      'write_file',
      'apply_patch',
      'copy_file',
      'rename_file',
      'delete_file',
      'install_dependency',
      'execute_migration',
      'set_environment_variable',
      // execution
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
      // git
      'create_branch',
      'create_checkpoint',
      'commit_changes',
      'restore_file',
      'revert_commit',
      'merge_branch',
      // release
      'create_preview',
      'run_preview_smoke_test',
      'create_release_candidate',
      'deploy_release',
      'check_deployment_health',
      'rollback_release',
    ]);
  });

  it('holds 45 unique names', () => {
    expect(TOOL_NAMES).toHaveLength(45);
    // Catches a duplicate pasted into both the source list and the pin above.
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('types a name union that rejects anything outside the list', () => {
    const known: ToolName = 'read_project_contract';
    // @ts-expect-error - not a PRD §16.1 tool name
    const unknown: ToolName = 'read_the_room';
    expect([known, unknown]).toHaveLength(2);
  });
});

describe('TOOL_GROUPS', () => {
  it('is exactly the five PRD §16.1 groups', () => {
    expect(Object.keys(TOOL_GROUPS)).toEqual(['read', 'mutation', 'execution', 'git', 'release']);
  });

  it('holds the read group verbatim', () => {
    expect(TOOL_GROUPS.read).toEqual([
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
    ]);
  });

  it('holds the mutation group verbatim', () => {
    expect(TOOL_GROUPS.mutation).toEqual([
      'write_file',
      'apply_patch',
      'copy_file',
      'rename_file',
      'delete_file',
      'install_dependency',
      'execute_migration',
      'set_environment_variable',
    ]);
  });

  it('holds the execution group verbatim', () => {
    expect(TOOL_GROUPS.execution).toEqual([
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
    ]);
  });

  it('holds the git group verbatim', () => {
    expect(TOOL_GROUPS.git).toEqual([
      'create_branch',
      'create_checkpoint',
      'commit_changes',
      'restore_file',
      'revert_commit',
      'merge_branch',
    ]);
  });

  it('holds the release group verbatim', () => {
    expect(TOOL_GROUPS.release).toEqual([
      'create_preview',
      'run_preview_smoke_test',
      'create_release_candidate',
      'deploy_release',
      'check_deployment_health',
      'rollback_release',
    ]);
  });

  it('concatenates to the flat tool list, in group order', () => {
    expect([
      ...TOOL_GROUPS.read,
      ...TOOL_GROUPS.mutation,
      ...TOOL_GROUPS.execution,
      ...TOOL_GROUPS.git,
      ...TOOL_GROUPS.release,
    ]).toEqual([...TOOL_NAMES]);
  });
});

describe('tool metadata schemas', () => {
  it('classifies tools as read-only or mutating', () => {
    expect(ToolClassificationSchema.options).toEqual(['read_only', 'mutating']);
    expect(ToolClassificationSchema.safeParse('destructive').success).toBe(false);
  });

  it('grades risk low, medium, high', () => {
    expect(ToolRiskLevelSchema.options).toEqual(['low', 'medium', 'high']);
  });

  it('routes approval automatically, by policy, or to a human', () => {
    expect(ToolApprovalPolicySchema.options).toEqual(['auto', 'policy', 'human']);
  });

  it('requires at least one retry attempt and a non-negative backoff', () => {
    expect(RetryPolicySchema.parse({ maxAttempts: 3, backoffMs: 0 })).toEqual({
      maxAttempts: 3,
      backoffMs: 0,
    });
    expect(RetryPolicySchema.safeParse({ maxAttempts: 0, backoffMs: 100 }).success).toBe(false);
    expect(RetryPolicySchema.safeParse({ maxAttempts: 1, backoffMs: -1 }).success).toBe(false);
  });
});

describe('ToolDefinition', () => {
  const inputSchema = z.object({ path: z.string().min(1) });
  const outputSchema = z.object({ bytes: z.number().int().nonnegative() });

  // Typing this definition is the test: the generic has to carry the input and
  // output schemas through to `userSummary`, which sees parsed values, not `any`.
  const readFile: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace.',
    inputSchema,
    outputSchema,
    classification: 'read_only',
    riskLevel: 'low',
    approvalPolicy: 'auto',
    idempotent: true,
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 2, backoffMs: 250 },
    redactOutput: false,
    userSummary: (input, output) => `Read ${input.path} (${String(output.bytes)} bytes)`,
  };

  it('summarises a call from its typed input and output', () => {
    expect(readFile.userSummary({ path: 'src/app.ts' }, { bytes: 128 })).toBe(
      'Read src/app.ts (128 bytes)',
    );
  });

  it('validates calls with the schemas it carries', () => {
    expect(readFile.inputSchema.safeParse({ path: '' }).success).toBe(false);
    expect(readFile.outputSchema.safeParse({ bytes: 1 }).success).toBe(true);
  });
});
