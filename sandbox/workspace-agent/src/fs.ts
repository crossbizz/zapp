import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import { AtomicWriteConflictError, PathViolationError, resolveInRoot } from '@zapp/workspace-runtime';

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

export interface AtomicWorkspaceFile {
  readonly path: string;
  readonly data: Uint8Array;
  readonly expectedRevision?: string;
}

export interface WorkspaceSearchInput {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly fixedStrings?: boolean;
  readonly ignoreCase?: boolean;
}

export interface WorkspaceSearchResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export class FileOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileOperationValidationError';
  }
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATH_HELPER = join(PACKAGE_ROOT, 'dist', 'native', 'path-helper');
const TYPED_EARLY_EXIT_CODES = new Set([65, 66]);

class NativePathHelperError extends Error {
  constructor(readonly exitCode: number | null) {
    super('Native workspace path helper failed');
    this.name = 'NativePathHelperError';
  }
}

function writeHelperInput(stream: Writable, input: Buffer): Promise<Error | undefined> {
  return new Promise((resolveInput) => {
    const onError = (error: Error): void => {
      resolveInput(error);
    };
    stream.once('error', onError);
    stream.end(input, (error?: Error | null) => {
      if (error === undefined || error === null) {
        stream.off('error', onError);
        resolveInput(undefined);
      } else {
        resolveInput(error);
      }
    });
  });
}

function isTypedEarlyExitPipeClosure(error: Error, exitCode: number | null): boolean {
  return (
    (error as NodeJS.ErrnoException).code === 'EPIPE' &&
    exitCode !== null &&
    TYPED_EARLY_EXIT_CODES.has(exitCode)
  );
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
    const inputCompletion =
      input === undefined || stdinStream === null
        ? Promise.resolve(undefined)
        : writeHelperInput(stdinStream, input);
    stdoutStream.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', rejectResult);
    child.once('close', (exitCode) => {
      void inputCompletion.then((inputError) => {
        if (inputError !== undefined && !isTypedEarlyExitPipeClosure(inputError, exitCode)) {
          rejectResult(inputError);
        } else if (exitCode !== 0) {
          rejectResult(new NativePathHelperError(exitCode));
        } else {
          resolveResult(Buffer.concat(stdout));
        }
      });
    });
  });
}

interface NativeHelperResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly truncated: boolean;
}

function runNativeHelper(
  args: readonly string[],
  input: Buffer | undefined,
  acceptedExitCodes: ReadonlySet<number>,
  outputLimit = Number.POSITIVE_INFINITY,
): Promise<NativeHelperResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(PATH_HELPER, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (child.stdout === null || child.stderr === null || (input !== undefined && child.stdin === null)) {
      child.kill('SIGKILL');
      rejectResult(new NativePathHelperError(null));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    const inputCompletion =
      input === undefined || child.stdin === null
        ? Promise.resolve(undefined)
        : writeHelperInput(child.stdin, input);
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = outputLimit - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      target.push(accepted);
      capturedBytes += accepted.length;
      if (accepted.length !== chunk.length) truncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.once('error', rejectResult);
    child.once('close', (exitCode) => {
      void inputCompletion.then((inputError) => {
        if (inputError !== undefined && !isTypedEarlyExitPipeClosure(inputError, exitCode)) {
          rejectResult(inputError);
        } else if (exitCode === null || !acceptedExitCodes.has(exitCode)) {
          rejectResult(new NativePathHelperError(exitCode));
        } else {
          resolveResult({
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            truncated,
          });
        }
      });
    });
  });
}

function translateAdvancedHelperError(error: unknown, path: string): never {
  if (error instanceof NativePathHelperError && error.exitCode === 65) {
    throw new PathViolationError(path);
  }
  if (error instanceof NativePathHelperError && error.exitCode === 66) {
    throw new FileOperationValidationError('Workspace file operation rejected');
  }
  throw error;
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

export class WorkspaceFileManager {
  private atomicCommitTail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.atomicCommitTail;
    let release: () => void = () => undefined;
    this.atomicCommitTail = new Promise<void>((resolveNext) => {
      release = resolveNext;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async write(path: string, body: Buffer): Promise<void> {
    await this.serialize(() => writeWorkspaceFile(this.root, path, body));
  }

  async validateGuardedSnapshotPath(path: string): Promise<never> {
    await resolveInRoot(this.root, path);
    throw new AtomicWriteConflictError();
  }

  async writeAtomically(files: readonly AtomicWorkspaceFile[]): Promise<void> {
    if (files.some((file) => file.expectedRevision !== undefined)) {
      throw new AtomicWriteConflictError();
    }
    for (const file of files) await resolveInRoot(this.root, file.path);
    const args = [
      'atomic-write',
      this.root,
      String(files.length),
      ...files.flatMap((file) => [file.path, String(file.data.byteLength)]),
    ];
    try {
      await this.serialize(() =>
        runNativeHelper(
          args,
          Buffer.concat(files.map((file) => Buffer.from(file.data))),
          new Set([0]),
        ),
      );
    } catch (error: unknown) {
      translateAdvancedHelperError(error, files[0]?.path ?? '.');
    }
  }

  async search(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
    await resolveInRoot(this.root, input.path);
    const args = [
      'search',
      this.root,
      input.path,
      input.pattern,
      input.glob ?? '',
      input.fixedStrings === true ? '1' : '0',
      input.ignoreCase === true ? '1' : '0',
      rgPath,
    ];
    const startedAt = Date.now();
    try {
      const result = await runNativeHelper(args, undefined, new Set([0, 1, 2]), 1_024 * 1_024);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr.toString('utf8'),
        durationMs: Date.now() - startedAt,
        truncated: result.truncated,
      };
    } catch (error: unknown) {
      translateAdvancedHelperError(error, input.path);
    }
  }

  async deleteFile(path: string): Promise<{ alreadyAbsent: boolean }> {
    await resolveInRoot(this.root, path);
    try {
      const result = await this.serialize(() =>
        runNativeHelper(['delete', this.root, path], undefined, new Set([0])),
      );
      return { alreadyAbsent: result.stdout.toString('utf8') === '1' };
    } catch (error: unknown) {
      translateAdvancedHelperError(error, path);
    }
  }

  async renameFile(input: {
    readonly source: string;
    readonly destination: string;
    readonly overwrite: 'replace';
  }): Promise<void> {
    await Promise.all([
      resolveInRoot(this.root, input.source),
      resolveInRoot(this.root, input.destination),
    ]);
    try {
      await this.serialize(() =>
        runNativeHelper(
          ['rename', this.root, input.source, input.destination],
          undefined,
          new Set([0]),
        ),
      );
    } catch (error: unknown) {
      translateAdvancedHelperError(error, input.source);
    }
  }
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
