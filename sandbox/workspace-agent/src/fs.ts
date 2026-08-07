import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PathViolationError, resolveInRoot } from '@zapp/workspace-runtime';

const NonEmptyNoNulStringSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed');

export const FileQuerySchema = z.object({ path: NonEmptyNoNulStringSchema }).strict();
export const ListQuerySchema = z
  .object({
    path: NonEmptyNoNulStringSchema.default('.'),
    glob: NonEmptyNoNulStringSchema.optional(),
    maxDepth: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

export const FileEntrySchema = z
  .object({
    path: z.string(),
    type: z.enum(['file', 'directory', 'symlink']),
  })
  .strict();
export const FileListSchema = z.array(FileEntrySchema);
export const BinaryBodySchema = z.instanceof(Buffer);

export type ListQuery = z.infer<typeof ListQuerySchema>;
export type FileEntry = z.infer<typeof FileEntrySchema>;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATH_HELPER = join(PACKAGE_ROOT, 'dist', 'native', 'path-helper');

class NativePathHelperError extends Error {
  constructor(readonly exitCode: number | null) {
    super('Native workspace path helper failed');
    this.name = 'NativePathHelperError';
  }
}

function globMatches(path: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'u').test(basename(path));
}

function runPathHelper(args: readonly string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(PATH_HELPER, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdoutStream = child.stdout;
    const stdinStream = child.stdin;
    if (stdoutStream === null || (input !== undefined && stdinStream === null)) {
      child.kill('SIGKILL');
      rejectResult(new NativePathHelperError(null));
      return;
    }
    const stdout: Buffer[] = [];
    stdoutStream.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', rejectResult);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolveResult(Buffer.concat(stdout));
      } else {
        rejectResult(new NativePathHelperError(exitCode));
      }
    });
    if (input !== undefined) {
      stdinStream?.end(input);
    }
  });
}

async function runPathOperation(
  operation: 'read' | 'write',
  root: string,
  path: string,
  input?: Buffer,
): Promise<Buffer> {
  try {
    return await runPathHelper([operation, root, path], operation === 'write' ? input : undefined);
  } catch (error) {
    if (error instanceof NativePathHelperError && error.exitCode === 65) {
      throw new PathViolationError(path);
    }
    throw error;
  }
}

async function runListOperation(root: string, path: string, maxDepth: number): Promise<Buffer> {
  try {
    return await runPathHelper(['list', root, path, String(maxDepth)]);
  } catch (error) {
    if (error instanceof NativePathHelperError && error.exitCode === 65) {
      throw new PathViolationError(path);
    }
    throw error;
  }
}

function parseNativeList(output: Buffer): FileEntry[] {
  const files: FileEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const terminator = output.indexOf(0, start);
    if (terminator <= start) {
      throw new NativePathHelperError(null);
    }
    const type = output.subarray(start, start + 1).toString('utf8');
    const path = output.subarray(start + 1, terminator).toString('utf8');
    const entryType = type === 'd' ? 'directory' : type === 'l' ? 'symlink' : 'file';
    files.push(FileEntrySchema.parse({ path, type: entryType }));
    start = terminator + 1;
  }
  return files;
}

export async function readWorkspaceFile(root: string, path: string): Promise<Buffer> {
  await resolveInRoot(root, path);
  return runPathOperation('read', root, path);
}

export async function writeWorkspaceFile(root: string, path: string, body: Buffer): Promise<void> {
  await resolveInRoot(root, path);
  await runPathOperation('write', root, path, body);
}

export async function listWorkspaceFiles(root: string, query: ListQuery): Promise<FileEntry[]> {
  await resolveInRoot(root, query.path);
  const maxDepth = query.maxDepth ?? Number.POSITIVE_INFINITY;
  const files = parseNativeList(
    await runListOperation(root, query.path, Number.isFinite(maxDepth) ? maxDepth : 2_147_483_647),
  );
  return FileListSchema.parse(
    files
      .filter((entry) => query.glob === undefined || globMatches(entry.path, query.glob))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}
