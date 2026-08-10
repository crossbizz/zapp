import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';
import type { ExecutionContract, ExecInput } from '@zapp/contracts';

export const MAX_EXEC_OUTPUT_BYTES = 1_024 * 1_024;
const DEV_SERVER_START_TIMEOUT_MS = 5_000;

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly terminationReason?: 'timeout';
}

export interface ExecChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly data: string;
  readonly at: string;
}

export interface FileEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
}

export interface FileStat extends FileEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface AtomicFileWrite {
  readonly path: string;
  readonly data: Uint8Array;
  readonly expectedRevision?: string;
}

export interface WorkspaceFileSnapshot {
  readonly data: Uint8Array;
  readonly revision: string;
}

export interface WorkspaceSearchInput {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly fixedStrings?: boolean;
  readonly ignoreCase?: boolean;
}

export interface WorkspaceRenameInput {
  readonly source: string;
  readonly destination: string;
  readonly overwrite: 'replace';
}

export interface AtomicFileOperations {
  read(path: string): Promise<Uint8Array>;
  metadata(path: string): Promise<{ mode: number; dev: number; ino: number }>;
  write(path: string, data: Uint8Array, mode?: number): Promise<void>;
  replace(source: string, destination: string): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface MemoryWorkspaceRuntimeOptions {
  readonly atomicFileOperations?: AtomicFileOperations;
  readonly environment?: NodeJS.ProcessEnv;
}

export type GitOperation =
  | 'status'
  | 'diff'
  | 'log'
  | 'show'
  | 'add_commit'
  | 'push'
  | 'checkout'
  | 'branch'
  | 'restore'
  | 'merge'
  | 'revert';

export type GitOp =
  | {
      readonly operation: Exclude<GitOperation, 'add_commit' | 'merge' | 'revert'>;
      readonly args?: readonly string[];
    }
  | {
      readonly operation: 'add_commit';
      readonly paths: readonly string[];
      readonly message: string;
    }
  | {
      readonly operation: 'merge';
      readonly ref: string;
    }
  | {
      readonly operation: 'revert';
      readonly commit: string;
    };

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkspaceRuntime {
  readonly kind: 'cloud' | 'local' | 'docker';
  exec(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    pty?: boolean;
  }): Promise<ExecResult>;
  execStream(input: ExecInput): AsyncIterable<ExecChunk>;
  readFile(path: string): Promise<Uint8Array>;
  readFileForUpdate(path: string): Promise<WorkspaceFileSnapshot>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  writeFilesAtomically(files: readonly AtomicFileWrite[]): Promise<void>;
  search(input: WorkspaceSearchInput): Promise<ExecResult>;
  listFiles(path: string, opts?: { glob?: string; maxDepth?: number }): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  delete(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(input: WorkspaceRenameInput): Promise<void>;
  git(op: GitOp): Promise<GitResult>;
  startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }>;
  restartDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }>;
  health(): Promise<{ ok: boolean; details: string }>;
}

export class PathViolationError extends Error {
  constructor(path: string) {
    super(`Path escapes workspace root: ${path}`);
    this.name = 'PathViolationError';
  }
}

export class AtomicWriteError extends Error {
  constructor(
    readonly code:
      | 'atomic_commit_failed'
      | 'atomic_rollback_failed'
      | 'atomic_cleanup_failed',
    readonly causes: readonly unknown[],
  ) {
    super(code);
    this.name = 'AtomicWriteError';
  }
}

export class AtomicWriteConflictError extends Error {
  readonly code = 'atomic_write_conflict' as const;

  constructor() {
    super('Atomic file changed before commit');
    this.name = 'AtomicWriteConflictError';
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
}

async function existingAncestor(path: string): Promise<string> {
  let current = path;

  for (;;) {
    try {
      return await realpath(current);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }

      const parent = resolve(current, '..');
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

/** Resolves a workspace-relative path and rejects lexical or symlink escapes. */
export async function resolveInRoot(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) {
    throw new PathViolationError(path);
  }

  const rootPath = await realpath(root);
  const resolved = resolve(rootPath, path);
  if (!isWithin(rootPath, resolved)) {
    throw new PathViolationError(path);
  }

  const resolvedAncestor = await existingAncestor(resolved);
  if (!isWithin(rootPath, resolvedAncestor)) {
    throw new PathViolationError(path);
  }

  return resolved;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function assertDistinctAbsentNames(
  files: readonly { canonicalTarget: string; metadata: undefined }[],
): Promise<void> {
  const namesByParent = new Map<string, string[]>();
  for (const file of files) {
    const parent = dirname(file.canonicalTarget);
    const names = namesByParent.get(parent) ?? [];
    names.push(basename(file.canonicalTarget));
    namesByParent.set(parent, names);
  }

  for (const [parent, names] of namesByParent) {
    if (names.length < 2) continue;
    const probe = await mkdtemp(resolve(parent, '.zapp-name-probe-'));
    try {
      for (const name of names) {
        try {
          await writeFile(resolve(probe, name), new Uint8Array(), { flag: 'wx', mode: 0o600 });
        } catch (error: unknown) {
          if (isFileSystemError(error, 'EEXIST')) {
            throw new Error('Atomic file batch contains duplicate targets');
          }
          throw error;
        }
      }
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
}

const SAFE_GIT_FLAGS: Readonly<
  Record<Exclude<GitOperation, 'add_commit' | 'merge' | 'revert'>, ReadonlySet<string>>
> = {
  status: new Set(['--short', '--porcelain', '--branch']),
  diff: new Set(['--cached', '--staged', '--stat', '--name-only', '--name-status', '--patch']),
  log: new Set(['--oneline', '--stat', '--name-only', '--name-status']),
  show: new Set(['--stat', '--name-only', '--name-status', '--patch']),
  push: new Set(['--force-with-lease', '--set-upstream']),
  checkout: new Set(['--detach', '--force']),
  branch: new Set(['--show-current', '--list']),
  restore: new Set(['--staged', '--worktree']),
};

async function validateGitPaths(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (path.startsWith('-') || path === '--') {
      throw new PathViolationError(path);
    }
    await resolveInRoot(root, path);
  }
}

async function validateGitArgs(
  root: string,
  operation: Exclude<GitOperation, 'add_commit' | 'merge' | 'revert'>,
  args: readonly string[],
): Promise<void> {
  let pathsFollow = false;
  for (const arg of args) {
    if (arg === '--') {
      pathsFollow = true;
      continue;
    }
    if (!pathsFollow && arg.startsWith('-')) {
      if (!SAFE_GIT_FLAGS[operation].has(arg)) {
        throw new PathViolationError(arg);
      }
      continue;
    }
    await resolveInRoot(root, arg);
  }
}

function validateMergeRef(ref: string): void {
  const components = ref.split('/');
  const containsUnsafeCharacter = /[\u0000-\u0020\u007f~^:?*[\\]/u.test(ref);
  const hasUnsafeComponent = components.some(
    (component) =>
      component.length === 0 || component.startsWith('.') || component.endsWith('.lock'),
  );

  if (
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith('-') ||
    ref.endsWith('.') ||
    ref.endsWith('/') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    containsUnsafeCharacter ||
    hasUnsafeComponent
  ) {
    throw new PathViolationError(ref);
  }
}

function validateCommitId(commit: string): void {
  if (!/^[0-9a-f]{7,64}$/iu.test(commit)) {
    throw new PathViolationError(commit);
  }
}

function validateRenameOverwrite(overwrite: unknown): asserts overwrite is 'replace' {
  if (overwrite !== 'replace') throw new Error('Unsupported rename overwrite behavior');
}

async function commandOutput(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.once('error', () => {
      resolveOutput('');
    });
    child.once('close', () => {
      resolveOutput(stdout);
    });
  });
}

async function linuxListenerPids(port: number): Promise<number[]> {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const rows = (await readFile(table, 'utf8')).split('\n').slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/u);
        const local = fields[1]?.split(':');
        if (
          local?.[1] !== undefined &&
          Number.parseInt(local[1], 16) === port &&
          fields[3] === '0A' &&
          fields[9] !== undefined
        ) {
          inodes.add(fields[9]);
        }
      }
    } catch {
      // A platform without this proc table falls through to no owned listener.
    }
  }
  if (inodes.size === 0) return [];

  const pids: number[] = [];
  let processEntries: string[] = [];
  try {
    processEntries = await readdir('/proc');
  } catch {
    return [];
  }
  for (const entry of processEntries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const descriptors = await readdir(`/proc/${entry}/fd`);
      for (const descriptor of descriptors) {
        const target = await readlink(`/proc/${entry}/fd/${descriptor}`);
        const match = /^socket:\[(\d+)\]$/u.exec(target);
        if (match?.[1] !== undefined && inodes.has(match[1])) {
          pids.push(Number(entry));
          break;
        }
      }
    } catch {
      // Other users' or already-exited processes are not candidates we can own.
    }
  }
  return pids;
}

async function listenerPids(port: number): Promise<number[]> {
  if (process.platform === 'linux') return linuxListenerPids(port);
  if (process.platform === 'win32') return [];
  const output = await commandOutput('lsof', [
    '-nP',
    '-t',
    `-iTCP:${String(port)}`,
    '-sTCP:LISTEN',
  ]);
  return output
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function processGroupId(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    try {
      const row = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
      const fields = row.slice(row.lastIndexOf(')') + 1).trim().split(/\s+/u);
      const group = Number(fields[2]);
      return Number.isInteger(group) && group > 0 ? group : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'win32') return undefined;
  const output = await commandOutput('ps', ['-o', 'pgid=', '-p', String(pid)]);
  const group = Number(output.trim());
  return Number.isInteger(group) && group > 0 ? group : undefined;
}

async function listenerBelongsToProcessGroup(port: number, groupId: number): Promise<boolean> {
  const pids = await listenerPids(port);
  const groups = await Promise.all(pids.map((pid) => processGroupId(pid)));
  return groups.includes(groupId);
}

async function httpProbeSucceeds(port: number, path: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      signal: AbortSignal.timeout(250),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function terminateProcessGroup(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group can already be gone; the child fallback is still safe.
    }
  }
  child.kill('SIGKILL');
}

function outputCollector() {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let truncated = false;

  function append(stream: 'stdout' | 'stderr', data: Buffer): void {
    const remaining = MAX_EXEC_OUTPUT_BYTES - outputBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    const accepted = data.subarray(0, remaining);
    if (accepted.length < data.length) {
      truncated = true;
    }
    outputBytes += accepted.length;
    (stream === 'stdout' ? stdout : stderr).push(accepted);
  }

  return {
    append,
    result(): Pick<ExecResult, 'stdout' | 'stderr' | 'truncated'> {
      return {
        stdout: trimIncompleteUtf8(Buffer.concat(stdout)).toString('utf8'),
        stderr: trimIncompleteUtf8(Buffer.concat(stderr)).toString('utf8'),
        truncated,
      };
    },
  };
}

function trimIncompleteUtf8(buffer: Buffer): Buffer {
  if (buffer.length === 0) {
    return buffer;
  }

  let sequenceStart = buffer.length - 1;
  while (sequenceStart > 0) {
    const byte = buffer.at(sequenceStart);
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    sequenceStart -= 1;
  }
  const firstByte = buffer.at(sequenceStart);
  if (firstByte === undefined) {
    return buffer;
  }
  const sequenceLength =
    firstByte < 0b1000_0000
      ? 1
      : firstByte < 0b1110_0000
        ? 2
        : firstByte < 0b1111_0000
          ? 3
          : firstByte < 0b1111_1000
            ? 4
            : 1;

  return buffer.length - sequenceStart < sequenceLength
    ? buffer.subarray(0, sequenceStart)
    : buffer;
}

/** A local, filesystem-backed runtime used as the test double for runtime consumers. */
export class MemoryWorkspaceRuntime implements WorkspaceRuntime {
  readonly kind = 'local' as const;
  private devServer: ChildProcess | undefined;
  private readonly atomicFileOperations: AtomicFileOperations;
  private readonly environment: NodeJS.ProcessEnv;
  private atomicCommitTail: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    options: MemoryWorkspaceRuntimeOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.atomicFileOperations = options.atomicFileOperations ?? {
      read: async (path) => new Uint8Array(await readFile(path)),
      metadata: async (path) => {
        const metadata = await stat(path);
        return { mode: metadata.mode, dev: metadata.dev, ino: metadata.ino };
      },
      write: async (path, data, mode) => {
        await writeFile(path, data, mode === undefined ? undefined : { mode });
      },
      replace: rename,
      setMode: chmod,
      remove: async (path) => rm(path, { force: true }),
    };
  }

  async exec(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    pty?: boolean;
  }): Promise<ExecResult> {
    const cwd = await resolveInRoot(this.root, input.cwd ?? '.');
    const startedAt = performance.now();
    const output = outputCollector();

    return new Promise<ExecResult>((resolveResult) => {
      const child = spawn(input.cmd, input.args, {
        cwd,
        env: { ...this.environment, ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let timedOut = false;
      let spawnError: Error | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child);
      }, input.timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        output.append('stdout', data);
      });
      child.stderr.on('data', (data: Buffer) => {
        output.append('stderr', data);
      });
      child.on('error', (error: Error) => {
        spawnError = error;
        output.append('stderr', Buffer.from(error.message));
      });
      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        const captured = output.result();
        resolveResult({
          exitCode: timedOut ? 124 : (exitCode ?? (spawnError === undefined ? 1 : 127)),
          durationMs: performance.now() - startedAt,
          ...(timedOut ? { terminationReason: 'timeout' as const } : {}),
          ...captured,
        });
      });
    });
  }

  async *execStream(input: ExecInput): AsyncIterable<ExecChunk> {
    const child = spawn(input.command, input.args, {
      cwd: await resolveInRoot(this.root, input.cwd ?? '.'),
      env: { ...this.environment, ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const chunks: ExecChunk[] = [];
    const state = { closed: false };
    let wake: (() => void) | undefined;
    const notify = (): void => {
      wake?.();
      wake = undefined;
    };
    const emit = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      chunks.push({ stream, data: data.toString('utf8'), at: new Date().toISOString() });
      notify();
    };
    const timeout = setTimeout(() => {
      terminateProcessGroup(child);
    }, input.timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      emit('stdout', data);
    });
    child.stderr.on('data', (data: Buffer) => {
      emit('stderr', data);
    });
    child.on('error', (error: Error) => {
      emit('stderr', Buffer.from(error.message));
    });
    child.on('close', () => {
      state.closed = true;
      notify();
    });

    try {
      while (!state.closed || chunks.length > 0) {
        const chunk = chunks.shift();
        if (chunk !== undefined) {
          yield chunk;
          continue;
        }
        await new Promise<void>((resolveNext) => {
          wake = resolveNext;
        });
      }
    } finally {
      clearTimeout(timeout);
      if (!state.closed) {
        terminateProcessGroup(child);
      }
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await resolveInRoot(this.root, path)));
  }

  async readFileForUpdate(path: string): Promise<WorkspaceFileSnapshot> {
    const target = await resolveInRoot(this.root, path);
    let isSymbolicLink: boolean;
    try {
      isSymbolicLink = (await lstat(target)).isSymbolicLink();
    } catch (error: unknown) {
      if (isFileSystemError(error, 'ENOENT') || isFileSystemError(error, 'ENOTDIR')) {
        throw new AtomicWriteConflictError();
      }
      throw error;
    }
    if (isSymbolicLink) {
      throw new Error(`Atomic file target must not be a symbolic link: ${path}`);
    }
    throw new AtomicWriteConflictError();
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const target = await resolveInRoot(this.root, path);
    await this.withAtomicCommit(async () => writeFile(target, data));
  }

  private async withAtomicCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.atomicCommitTail;
    let release: (() => void) | undefined;
    this.atomicCommitTail = new Promise<void>((resolveNext) => {
      release = resolveNext;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async writeFilesAtomically(files: readonly AtomicFileWrite[]): Promise<void> {
    const resolvedFiles = await Promise.all(
      files.map(async (file) => {
        const target = await resolveInRoot(this.root, file.path);
        let canonicalTarget: string;
        let metadata: { mode: number; dev: number; ino: number } | undefined;
        try {
          const leaf = await lstat(target);
          if (leaf.isSymbolicLink()) {
            throw new Error(`Atomic file target must not be a symbolic link: ${file.path}`);
          }
          [canonicalTarget, metadata] = await Promise.all([
            realpath(target),
            this.atomicFileOperations.metadata(target),
          ]);
        } catch (error: unknown) {
          if (!isFileSystemError(error, 'ENOENT')) {
            throw error;
          }
          canonicalTarget = resolve(await realpath(dirname(target)), basename(target));
        }
        return { ...file, target, canonicalTarget, metadata };
      }),
    );

    const canonicalTargets = new Set<string>();
    const existingObjects = new Set<string>();
    for (const file of resolvedFiles) {
      const objectIdentity =
        file.metadata !== undefined && file.metadata.ino !== 0
          ? `${String(file.metadata.dev)}:${String(file.metadata.ino)}`
          : undefined;
      if (
        canonicalTargets.has(file.canonicalTarget) ||
        (objectIdentity !== undefined && existingObjects.has(objectIdentity))
      ) {
        throw new Error('Atomic file batch contains duplicate targets');
      }
      canonicalTargets.add(file.canonicalTarget);
      if (objectIdentity !== undefined) existingObjects.add(objectIdentity);
    }

    await assertDistinctAbsentNames(
      resolvedFiles.filter(
        (file): file is typeof file & { metadata: undefined } => file.metadata === undefined,
      ),
    );

    if (resolvedFiles.some((file) => file.expectedRevision !== undefined)) {
      throw new AtomicWriteConflictError();
    }

    const staged = await Promise.all(
      resolvedFiles.map(async (file) => {
        const temporary = resolve(dirname(file.target), `.zapp-atomic-${randomUUID()}`);
        const original =
          file.metadata === undefined
            ? undefined
            : {
                data: await this.atomicFileOperations.read(file.target),
                mode: file.metadata.mode & 0o7777,
              };
        return {
          target: file.target,
          temporary,
          data: file.data,
          original,
        };
      }),
    );

    let failure: unknown;
    try {
      for (const file of staged) {
        await this.atomicFileOperations.write(file.temporary, file.data, file.original?.mode);
        if (file.original !== undefined) {
          await this.atomicFileOperations.setMode(file.temporary, file.original.mode);
        }
      }
      await this.withAtomicCommit(async () => {
        const committed: typeof staged = [];
        try {
          for (const file of staged) {
            committed.push(file);
            await this.atomicFileOperations.replace(file.temporary, file.target);
          }
        } catch (error: unknown) {
          const rollbackFailures: unknown[] = [];
          for (const file of committed.reverse()) {
            try {
              if (file.original === undefined) {
                await this.atomicFileOperations.remove(file.target);
              } else {
                await this.atomicFileOperations.write(
                  file.target,
                  file.original.data,
                  file.original.mode,
                );
                await this.atomicFileOperations.setMode(file.target, file.original.mode);
              }
            } catch (rollbackError: unknown) {
              rollbackFailures.push(rollbackError);
            }
          }
          failure =
            rollbackFailures.length === 0 && error instanceof AtomicWriteConflictError
              ? error
              : rollbackFailures.length === 0
                ? new AtomicWriteError('atomic_commit_failed', [error])
                : new AtomicWriteError('atomic_rollback_failed', [error, ...rollbackFailures]);
        }
      });
    } catch (error: unknown) {
      failure = error;
    }

    const cleanup = await Promise.allSettled(
      staged.map((file) => this.atomicFileOperations.remove(file.temporary)),
    );
    const cleanupFailures: unknown[] = [];
    for (const result of cleanup) {
      if (result.status === 'rejected') cleanupFailures.push(result.reason as unknown);
    }
    if (cleanupFailures.length > 0) {
      throw new AtomicWriteError('atomic_cleanup_failed', [
        ...(failure === undefined ? [] : [failure]),
        ...cleanupFailures,
      ]);
    }
    if (failure !== undefined) {
      if (failure instanceof Error) throw failure;
      throw new AtomicWriteError('atomic_commit_failed', [failure]);
    }
  }

  async search(input: WorkspaceSearchInput): Promise<ExecResult> {
    const root = await realpath(this.root);
    const canonical = await realpath(await resolveInRoot(this.root, input.path));
    if (!isWithin(root, canonical)) throw new PathViolationError(input.path);
    const searchPath = relative(root, canonical) || '.';
    const args = ['--line-number', '--color', 'never'];
    if (input.glob !== undefined) args.push('--glob', input.glob);
    if (input.fixedStrings === true) args.push('--fixed-strings');
    if (input.ignoreCase === true) args.push('--ignore-case');
    args.push('--', input.pattern, searchPath);
    return this.exec({ cmd: rgPath, args, timeoutMs: 30_000 });
  }

  async listFiles(
    path: string,
    opts: { glob?: string; maxDepth?: number } = {},
  ): Promise<FileEntry[]> {
    const directory = await resolveInRoot(this.root, path);
    const root = await resolveInRoot(this.root, '.');
    const files: FileEntry[] = [];
    const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;

    const visit = async (current: string, depth: number): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const child = await resolveInRoot(this.root, relative(root, resolve(current, entry.name)));
        const relativePath = relative(directory, child);
        const type = entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'file';
        if (opts.glob === undefined || relativePath.includes(opts.glob.replaceAll('*', ''))) {
          files.push({ path: relativePath, type });
        }
        if (entry.isDirectory() && depth < maxDepth) {
          await visit(child, depth + 1);
        }
      }
    };

    await visit(directory, 0);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = await resolveInRoot(this.root, path);
    const metadata = await stat(resolved);
    return {
      path,
      type: metadata.isDirectory() ? 'directory' : metadata.isSymbolicLink() ? 'symlink' : 'file',
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
  }

  async delete(path: string): Promise<void> {
    await rm(await resolveInRoot(this.root, path), { recursive: true, force: true });
  }

  async deleteFile(path: string): Promise<void> {
    const target = await resolveInRoot(this.root, path);
    try {
      await unlink(target);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  async renameFile(input: WorkspaceRenameInput): Promise<void> {
    const source = await resolveInRoot(this.root, input.source);
    const destination = await resolveInRoot(this.root, input.destination);
    if (source === destination) throw new Error('source and destination must differ');
    validateRenameOverwrite(input.overwrite);
    const sourceMetadata = await lstat(source);
    if (!sourceMetadata.isFile()) throw new Error('renameFile only accepts regular files');
    let destinationMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
    let destinationCanonical: string | undefined;
    try {
      [destinationMetadata, destinationCanonical] = await Promise.all([
        lstat(destination),
        realpath(destination),
      ]);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (
      destinationCanonical === (await realpath(source)) ||
      (destinationMetadata !== undefined &&
        sourceMetadata.ino !== 0 &&
        sourceMetadata.dev === destinationMetadata.dev &&
        sourceMetadata.ino === destinationMetadata.ino)
    ) {
      throw new Error('source and destination must differ');
    }
    await rename(source, destination);
  }

  async git(op: GitOp): Promise<GitResult> {
    if (op.operation === 'add_commit') {
      await validateGitPaths(this.root, op.paths);
      const add = await this.exec({
        cmd: 'git',
        args: ['add', '--', ...op.paths],
        timeoutMs: 30_000,
      });
      if (add.exitCode !== 0) {
        return add;
      }
      return this.exec({
        cmd: 'git',
        args: ['commit', '-m', op.message],
        timeoutMs: 30_000,
      });
    }

    if (op.operation === 'merge') {
      validateMergeRef(op.ref);
      return this.exec({
        cmd: 'git',
        args: ['merge', '--no-edit', '--', op.ref],
        timeoutMs: 30_000,
      });
    }

    if (op.operation === 'revert') {
      validateCommitId(op.commit);
      return this.exec({
        cmd: 'git',
        args: ['revert', '--no-edit', '--', op.commit],
        timeoutMs: 30_000,
      });
    }

    await validateGitArgs(this.root, op.operation, op.args ?? []);
    return this.exec({
      cmd: 'git',
      args: [op.operation, ...(op.args ?? [])],
      timeoutMs: 30_000,
    });
  }

  async startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }> {
    if (this.devServer !== undefined && this.devServer.exitCode === null) {
      throw new Error('Development server is already running');
    }
    const child = spawn(contract.develop.command, {
      cwd: await resolveInRoot(this.root, contract.workspace_root),
      shell: true,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    if (child.pid === undefined) {
      throw new Error('Could not start development server');
    }

    await new Promise<void>((resolveReady, rejectReady) => {
      let checking = false;
      let settled = false;
      const complete = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        child.off('error', onError);
        child.off('close', onClose);
        callback();
      };
      const checkReadiness = (): void => {
        if (checking || settled) {
          return;
        }
        checking = true;
        void listenerBelongsToProcessGroup(contract.develop.port, child.pid ?? -1)
          .then(async (owned) =>
            owned
              ? httpProbeSucceeds(contract.develop.port, contract.health?.path ?? '/')
              : false,
          )
          .then((ready) => {
            checking = false;
            if (ready) {
              complete(resolveReady);
            }
          });
      };
      const onError = (error: Error): void => {
        terminateProcessGroup(child);
        complete(() => {
          rejectReady(error);
        });
      };
      const onClose = (): void => {
        terminateProcessGroup(child);
        complete(() => {
          rejectReady(new Error('Development server exited before readiness'));
        });
      };
      const interval = setInterval(checkReadiness, 50);
      const timeout = setTimeout(() => {
        terminateProcessGroup(child);
        complete(() => {
          rejectReady(new Error('Development server did not become ready'));
        });
      }, DEV_SERVER_START_TIMEOUT_MS);

      child.once('error', onError);
      child.once('close', onClose);
      checkReadiness();
    });

    this.devServer = child;
    return { port: contract.develop.port, pid: child.pid };
  }

  async restartDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }> {
    const current = this.devServer;
    if (current !== undefined && current.exitCode === null) {
      const stopped = new Promise<void>((resolveStopped) => {
        current.once('close', () => {
          resolveStopped();
        });
      });
      terminateProcessGroup(current);
      await stopped;
    }
    if (this.devServer === current) {
      this.devServer = undefined;
    }
    return this.startDevServer(contract);
  }

  async health(): Promise<{ ok: boolean; details: string }> {
    await resolveInRoot(this.root, '.');
    return { ok: true, details: 'memory workspace runtime ready' };
  }
}
