import { readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { ExecutionContract, ExecInput } from '@zapp/contracts';

export const MAX_EXEC_OUTPUT_BYTES = 1_024 * 1_024;

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
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

export type GitOperation =
  | 'status'
  | 'diff'
  | 'log'
  | 'show'
  | 'add_commit'
  | 'push'
  | 'checkout'
  | 'branch'
  | 'restore';

export type GitOp =
  | {
      readonly operation: Exclude<GitOperation, 'add_commit'>;
      readonly args?: readonly string[];
    }
  | {
      readonly operation: 'add_commit';
      readonly paths: readonly string[];
      readonly message: string;
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
  writeFile(path: string, data: Uint8Array): Promise<void>;
  listFiles(path: string, opts?: { glob?: string; maxDepth?: number }): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  delete(path: string): Promise<void>;
  git(op: GitOp): Promise<GitResult>;
  startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }>;
  health(): Promise<{ ok: boolean; details: string }>;
}

export class PathViolationError extends Error {
  constructor(path: string) {
    super(`Path escapes workspace root: ${path}`);
    this.name = 'PathViolationError';
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
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      };
    },
  };
}

/** A local, filesystem-backed runtime used as the test double for runtime consumers. */
export class MemoryWorkspaceRuntime implements WorkspaceRuntime {
  readonly kind = 'local' as const;

  constructor(readonly root: string) {}

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
        env: { ...process.env, ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timedOut = false;
      let spawnError: Error | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
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
          ...captured,
        });
      });
    });
  }

  async *execStream(input: ExecInput): AsyncIterable<ExecChunk> {
    const result = await this.exec({
      cmd: input.command,
      args: input.args,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
      timeoutMs: input.timeoutMs,
      ...(input.pty === undefined ? {} : { pty: input.pty }),
    });
    const at = new Date().toISOString();

    if (result.stdout !== '') {
      yield { stream: 'stdout', data: result.stdout, at };
    }
    if (result.stderr !== '') {
      yield { stream: 'stderr', data: result.stderr, at };
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await resolveInRoot(this.root, path)));
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await writeFile(await resolveInRoot(this.root, path), data);
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
        const type = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file';
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

  async git(op: GitOp): Promise<GitResult> {
    if (op.operation === 'add_commit') {
      const add = await this.exec({
        cmd: 'git',
        args: ['add', ...op.paths],
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

    return this.exec({
      cmd: 'git',
      args: [op.operation, ...(op.args ?? [])],
      timeoutMs: 30_000,
    });
  }

  async startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }> {
    const child = spawn(contract.develop.command, {
      cwd: await resolveInRoot(this.root, contract.workspace_root),
      shell: true,
      stdio: 'ignore',
    });
    if (child.pid === undefined) {
      throw new Error('Could not start development server');
    }
    return { port: contract.develop.port, pid: child.pid };
  }

  async health(): Promise<{ ok: boolean; details: string }> {
    await resolveInRoot(this.root, '.');
    return { ok: true, details: 'memory workspace runtime ready' };
  }
}
