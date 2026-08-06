import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';
import type { AnyToolSpec, ToolSpec } from './registry.js';

function safeRef(ref: string): boolean {
  const components = ref.split('/');
  return (
    ref.length <= 255 &&
    !ref.startsWith('-') &&
    !ref.endsWith('.') &&
    !ref.endsWith('/') &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(ref) &&
    components.every(
      (component) =>
        component.length > 0 && !component.startsWith('.') && !component.endsWith('.lock'),
    )
  );
}

const refSchema = z.string().min(1).refine(safeRef, 'Unsafe Git ref');
const commitSchema = z.string().regex(/^[0-9a-f]{7,64}$/iu);
const pathSchema = z.string().min(1);
const GitOutputSchema = z
  .object({ ok: z.boolean(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();

function gitOutput(
  result: Awaited<ReturnType<WorkspaceRuntime['git']>>,
): z.infer<typeof GitOutputSchema> {
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function gitTool<I extends z.ZodTypeAny>(
  spec: Omit<
    ToolSpec<I, typeof GitOutputSchema>,
    'classification' | 'riskLevel' | 'approvalPolicy' | 'retryPolicy' | 'redactOutput'
  >,
): AnyToolSpec {
  return {
    ...spec,
    classification: 'mutating',
    riskLevel: 'medium',
    approvalPolicy: 'policy',
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    redactOutput: true,
  } as unknown as AnyToolSpec;
}

function summary(action: string, output: z.infer<typeof GitOutputSchema>): string {
  return output.ok ? action : `${action} failed (exit ${String(output.exitCode)})`;
}

function audit(output: z.infer<typeof GitOutputSchema>) {
  return { ok: output.ok, exitCode: output.exitCode };
}

export function createGitTools(runtime: WorkspaceRuntime): AnyToolSpec[] {
  const createBranchInput = z.object({ name: refSchema }).strict();
  const commitInput = z
    .object({
      paths: z.array(pathSchema).min(1).max(1_000),
      message: z.string().min(1).max(10_000),
    })
    .strict();
  const restoreInput = z.object({ path: pathSchema }).strict();
  const revertInput = z.object({ commit: commitSchema }).strict();
  const mergeInput = z.object({ ref: refSchema }).strict();

  return [
    gitTool({
      name: 'create_branch',
      description: 'Create a validated branch through WorkspaceRuntime.git.',
      inputSchema: createBranchInput,
      outputSchema: GitOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) =>
        gitOutput(await runtime.git({ operation: 'branch', args: [input.name] })),
      userSummary: (input, output) => summary(`Created branch ${input.name}`, output),
      auditPayload: (input, output) => ({ branch: input.name, ...audit(output) }),
    }),
    gitTool({
      name: 'create_checkpoint',
      description: 'Create a checkpoint commit through WorkspaceRuntime.git.',
      inputSchema: commitInput,
      outputSchema: GitOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) =>
        gitOutput(
          await runtime.git({
            operation: 'add_commit',
            paths: input.paths,
            message: input.message,
          }),
        ),
      userSummary: (_input, output) => summary('Created checkpoint', output),
      auditPayload: (input, output) => ({ pathCount: input.paths.length, ...audit(output) }),
    }),
    gitTool({
      name: 'commit_changes',
      description: 'Commit selected workspace changes through WorkspaceRuntime.git.',
      inputSchema: commitInput,
      outputSchema: GitOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) =>
        gitOutput(
          await runtime.git({
            operation: 'add_commit',
            paths: input.paths,
            message: input.message,
          }),
        ),
      userSummary: (_input, output) => summary('Committed workspace changes', output),
      auditPayload: (input, output) => ({ pathCount: input.paths.length, ...audit(output) }),
    }),
    gitTool({
      name: 'restore_file',
      description: 'Restore one workspace file through WorkspaceRuntime.git.',
      inputSchema: restoreInput,
      outputSchema: GitOutputSchema,
      idempotent: true,
      timeoutMs: 30_000,
      run: async (input) =>
        gitOutput(
          await runtime.git({ operation: 'restore', args: ['--worktree', '--', input.path] }),
        ),
      userSummary: (input, output) => summary(`Restored ${input.path}`, output),
      auditPayload: (input, output) => ({ path: input.path, ...audit(output) }),
    }),
    gitTool({
      name: 'revert_commit',
      description: 'Revert one validated commit through the typed runtime operation.',
      inputSchema: revertInput,
      outputSchema: GitOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) =>
        gitOutput(await runtime.git({ operation: 'revert', commit: input.commit })),
      userSummary: (input, output) => summary(`Reverted commit ${input.commit}`, output),
      auditPayload: (input, output) => ({ commit: input.commit, ...audit(output) }),
    }),
    gitTool({
      name: 'merge_branch',
      description: 'Merge one validated ref through the typed runtime operation.',
      inputSchema: mergeInput,
      outputSchema: GitOutputSchema,
      idempotent: false,
      timeoutMs: 30_000,
      run: async (input) => gitOutput(await runtime.git({ operation: 'merge', ref: input.ref })),
      userSummary: (input, output) => summary(`Merged ${input.ref}`, output),
      auditPayload: (input, output) => ({ ref: input.ref, ...audit(output) }),
    }),
  ];
}
