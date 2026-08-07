import { z } from 'zod';
import { resolveInRoot } from '@zapp/workspace-runtime';
import type { ExecManager } from './exec.js';

const GitOperationSchema = z.enum([
  'status',
  'diff',
  'log',
  'show',
  'push',
  'checkout',
  'branch',
  'restore',
]);
const NoNulStringSchema = z
  .string()
  .refine((value) => !value.includes('\0'), 'NUL is not allowed');
const NonEmptyNoNulStringSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed');

const StandardGitRequestSchema = z
  .object({ operation: GitOperationSchema, args: z.array(NoNulStringSchema).optional() })
  .strict();
const AddCommitGitRequestSchema = z
  .object({
    operation: z.literal('add_commit'),
    paths: z.array(NoNulStringSchema).min(1),
    message: NonEmptyNoNulStringSchema,
  })
  .strict();

export const GitRequestSchema = z.discriminatedUnion('operation', [
  StandardGitRequestSchema,
  AddCommitGitRequestSchema,
]);
export type GitRequest = z.infer<typeof GitRequestSchema>;

export const GitResultSchema = z
  .object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();
export type GitResult = z.infer<typeof GitResultSchema>;

const SAFE_GIT_FLAGS: Readonly<Record<z.infer<typeof GitOperationSchema>, ReadonlySet<string>>> = {
  status: new Set(['--short', '--porcelain', '--branch']),
  diff: new Set(['--cached', '--staged', '--stat', '--name-only', '--name-status', '--patch']),
  log: new Set(['--oneline', '--stat', '--name-only', '--name-status']),
  show: new Set(['--stat', '--name-only', '--name-status', '--patch']),
  push: new Set(['--force-with-lease', '--set-upstream']),
  checkout: new Set(['--detach', '--force']),
  branch: new Set(['--show-current', '--list']),
  restore: new Set(['--staged', '--worktree']),
};

async function validatePaths(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (path.startsWith('-') || path === '--') {
      throw new Error('Unsafe git path');
    }
    await resolveInRoot(root, path);
  }
}

async function validateArgs(
  root: string,
  operation: z.infer<typeof GitOperationSchema>,
  args: readonly string[],
): Promise<void> {
  let pathsFollow = false;
  for (const arg of args) {
    if (arg === '--') {
      pathsFollow = true;
    } else if (!pathsFollow && arg.startsWith('-')) {
      if (!SAFE_GIT_FLAGS[operation].has(arg)) {
        throw new Error('Unsafe git flag');
      }
    } else {
      await resolveInRoot(root, arg);
    }
  }
}

async function executeGit(execManager: ExecManager, args: readonly string[]): Promise<GitResult> {
  const result = await execManager.run({
    cmd: 'git',
    args: [...args],
    timeoutMs: 30_000,
  });
  return GitResultSchema.parse({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export async function runGit(
  root: string,
  request: GitRequest,
  execManager: ExecManager,
): Promise<GitResult> {
  if (request.operation === 'add_commit') {
    await validatePaths(root, request.paths);
    const added = await executeGit(execManager, ['add', '--', ...request.paths]);
    if (added.exitCode !== 0) {
      return added;
    }
    return executeGit(execManager, ['commit', '-m', request.message]);
  }

  const args = request.args ?? [];
  await validateArgs(root, request.operation, args);
  return executeGit(execManager, [request.operation, ...args]);
}
