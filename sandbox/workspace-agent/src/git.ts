import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const NoNulStringSchema = z.string().refine((value) => !value.includes('\0'), 'NUL is not allowed');
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

async function executeGit(
  execManager: ExecManager,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<GitResult> {
  const result = await execManager.run({
    cmd: 'git',
    args: [...args],
    ...(env === undefined ? {} : { env: { ...env } }),
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

export async function commitDirectEdit(
  root: string,
  path: string,
  data: Uint8Array,
  execManager: ExecManager,
): Promise<{ readonly exitCode: number; readonly commitSha?: string }> {
  await validatePaths(root, [path]);
  const checkedPath = await resolveInRoot(root, path);
  const mode = ((await stat(checkedPath)).mode & 0o111) === 0 ? '100644' : '100755';
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'zapp-direct-edit-'));
  const blobPath = join(temporaryDirectory, 'blob');
  const indexPath = join(temporaryDirectory, 'index');
  const indexEnvironment = { GIT_INDEX_FILE: indexPath };
  const literalGit = (...args: readonly string[]) =>
    executeGit(execManager, ['--literal-pathspecs', ...args]);
  let temporaryDirectoryRemoved = false;
  try {
    await writeFile(blobPath, data, { mode: 0o600 });
    const head = await literalGit('rev-parse', '--verify', 'HEAD');
    const expectedHead = head.stdout.trim();
    if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(expectedHead)) {
      return { exitCode: head.exitCode === 0 ? 1 : head.exitCode };
    }
    const blob = await literalGit('hash-object', '-w', '--no-filters', '--', blobPath);
    const blobSha = blob.stdout.trim();
    if (blob.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(blobSha)) {
      return { exitCode: blob.exitCode === 0 ? 1 : blob.exitCode };
    }
    const readTree = await executeGit(
      execManager,
      ['--literal-pathspecs', 'read-tree', expectedHead],
      indexEnvironment,
    );
    if (readTree.exitCode !== 0) return { exitCode: readTree.exitCode };
    const updatedIndex = await executeGit(
      execManager,
      ['--literal-pathspecs', 'update-index', '--add', '--cacheinfo', `${mode},${blobSha},${path}`],
      indexEnvironment,
    );
    if (updatedIndex.exitCode !== 0) return { exitCode: updatedIndex.exitCode };
    const tree = await executeGit(
      execManager,
      ['--literal-pathspecs', 'write-tree'],
      indexEnvironment,
    );
    const treeSha = tree.stdout.trim();
    if (tree.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(treeSha)) {
      return { exitCode: tree.exitCode === 0 ? 1 : tree.exitCode };
    }
    const commit = await literalGit(
      'commit-tree',
      treeSha,
      '-p',
      expectedHead,
      '-m',
      'manual edit via web',
    );
    const commitSha = commit.stdout.trim();
    if (commit.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(commitSha)) {
      return { exitCode: commit.exitCode === 0 ? 1 : commit.exitCode };
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectoryRemoved = true;
    const updatedHead = await literalGit('update-ref', 'HEAD', commitSha, expectedHead);
    if (updatedHead.exitCode !== 0) return { exitCode: updatedHead.exitCode };
    const updatedRealIndex = await literalGit(
      'update-index',
      '--add',
      '--cacheinfo',
      `${mode},${blobSha},${path}`,
    );
    if (updatedRealIndex.exitCode === 0) return { exitCode: 0, commitSha };
    const rolledBackHead = await literalGit('update-ref', 'HEAD', expectedHead, commitSha);
    return {
      exitCode: rolledBackHead.exitCode === 0 ? updatedRealIndex.exitCode : rolledBackHead.exitCode,
    };
  } finally {
    if (!temporaryDirectoryRemoved) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
