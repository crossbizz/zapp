import { exec as execBundledGit } from "dugite";
import { lstat } from "node:fs/promises";
import { spawn as spawnPty } from "node-pty";
import { relative, sep } from "node:path";
import {
  MAX_EXEC_OUTPUT_BYTES,
  MemoryWorkspaceRuntime,
  resolveInRoot,
  type AtomicFileWrite,
  type ExecResult,
  type FileEntry,
  type FileStat,
  type WorkspaceFileSnapshot,
  type WorkspaceRenameInput,
} from "@zapp/workspace-runtime";

function elapsed(startedAt: number): number {
  return performance.now() - startedAt;
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_EXEC_OUTPUT_BYTES) {
    return { text: value, truncated: false };
  }
  let end = MAX_EXEC_OUTPUT_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

const SAFE_CHILD_ENVIRONMENT_NAMES = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

function safeChildEnvironment(): Record<string, string> {
  const entries = SAFE_CHILD_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : ([[name, value]] as const);
  });
  return Object.fromEntries(entries);
}

function ptyEnvironment(
  baseline: Record<string, string>,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const entries = Object.entries({ ...baseline, ...overrides }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.fromEntries(entries);
}

/**
 * Electron main-process implementation of the shared workspace contract.
 *
 * Filesystem confinement, atomic writes, search, Git argument validation, and
 * dev-server ownership are inherited from the shared WS-1 implementation. The
 * desktop-specific boundary adds a real PTY and forces every Git invocation
 * through Dugite's packaged Git distribution.
 */
export class LocalWorkspaceRuntime extends MemoryWorkspaceRuntime {
  private readonly childEnvironment: Record<string, string>;

  constructor(root: string) {
    const childEnvironment = safeChildEnvironment();
    super(root, { environment: childEnvironment });
    this.childEnvironment = childEnvironment;
  }

  override async exec(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    pty?: boolean;
  }): Promise<ExecResult> {
    if (input.cmd === "git" && input.pty !== true) {
      return await this.execGit(input);
    }
    if (input.pty !== true) {
      return await super.exec(input);
    }
    return await this.execPty(input);
  }

  private async execGit(input: {
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<ExecResult> {
    const cwd = await resolveInRoot(this.root, input.cwd ?? ".");
    const startedAt = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Git command timed out"));
    }, input.timeoutMs);

    try {
      const result = await execBundledGit(input.args, cwd, {
        env: { ...this.childEnvironment, ...input.env },
        signal: controller.signal,
      });
      const stdout = boundedText(result.stdout);
      const stderr = boundedText(result.stderr);
      return {
        exitCode: timedOut ? 124 : result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: elapsed(startedAt),
        truncated: stdout.truncated || stderr.truncated,
        ...(timedOut ? { terminationReason: "timeout" as const } : {}),
      };
    } catch (error) {
      return {
        exitCode: timedOut ? 124 : 127,
        stdout: "",
        stderr:
          error instanceof Error
            ? error.message
            : "Bundled Git failed to start",
        durationMs: elapsed(startedAt),
        truncated: false,
        ...(timedOut ? { terminationReason: "timeout" as const } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async execPty(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<ExecResult> {
    const cwd = await resolveInRoot(this.root, input.cwd ?? ".");
    const startedAt = performance.now();

    return await new Promise<ExecResult>((resolve) => {
      let terminal;
      try {
        terminal = spawnPty(input.cmd, input.args, {
          name: "xterm-256color",
          cols: 120,
          rows: 30,
          cwd,
          env: ptyEnvironment(this.childEnvironment, input.env),
        });
      } catch (error) {
        resolve({
          exitCode: 127,
          stdout: "",
          stderr:
            error instanceof Error
              ? error.message
              : "PTY command failed to start",
          durationMs: elapsed(startedAt),
          truncated: false,
        });
        return;
      }

      let output = "";
      let outputBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let boundedSettlement: NodeJS.Timeout | undefined;
      let dataSubscription: ReturnType<typeof terminal.onData> | undefined;
      let exitSubscription: ReturnType<typeof terminal.onExit> | undefined;
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        if (boundedSettlement !== undefined) clearTimeout(boundedSettlement);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
        resolve({
          exitCode: timedOut ? 124 : exitCode,
          stdout: output,
          stderr: "",
          durationMs: elapsed(startedAt),
          truncated,
          ...(timedOut ? { terminationReason: "timeout" as const } : {}),
        });
      };
      const signalTree = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform === "win32") {
            terminal.kill(signal);
          } else {
            process.kill(-terminal.pid, signal);
          }
        } catch {
          try {
            terminal.kill(signal);
          } catch {
            // Bounded settlement below still releases the caller.
          }
        }
      };
      dataSubscription = terminal.onData((chunk) => {
        if (outputBytes >= MAX_EXEC_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const remaining = MAX_EXEC_OUTPUT_BYTES - outputBytes;
        const bounded = boundedText(
          Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8"),
        );
        output += bounded.text;
        outputBytes += Buffer.byteLength(bounded.text, "utf8");
        truncated ||=
          bounded.truncated || Buffer.byteLength(chunk, "utf8") > remaining;
      });
      exitSubscription = terminal.onExit(({ exitCode }) => {
        finish(exitCode);
      });
      timeout = setTimeout(() => {
        timedOut = true;
        signalTree("SIGTERM");
        forceKill = setTimeout(() => signalTree("SIGKILL"), 100);
        boundedSettlement = setTimeout(() => finish(124), 400);
      }, input.timeoutMs);
    });
  }
}

export class LocalAgentPathDeniedError extends Error {
  constructor(path: string) {
    super(
      `Path is outside the local agent's tracked or owned file set: ${path}`,
    );
    this.name = "LocalAgentPathDeniedError";
  }
}

export interface LocalAgentOwnedPathStore {
  load(): readonly string[];
  apply(input: {
    readonly add: readonly string[];
    readonly remove: readonly string[];
  }): void;
}

/**
 * Model-facing local runtime. It exposes only Git-tracked files and files
 * created by this agent instance; ignored/untracked host files and Git
 * metadata never cross the model boundary.
 */
export class LocalAgentWorkspaceRuntime extends LocalWorkspaceRuntime {
  private readonly ownedPaths = new Set<string>();

  constructor(
    root: string,
    private readonly ownership?: LocalAgentOwnedPathStore,
  ) {
    super(root);
  }

  async hydrateOwnedPaths(paths: readonly string[]): Promise<void> {
    const normalized = await Promise.all(
      paths.map(async (path) => await this.modelPath(path)),
    );
    for (const path of normalized) this.ownedPaths.add(path);
  }

  private async modelPath(path: string): Promise<string> {
    const resolved = await resolveInRoot(this.root, path);
    const normalized = relative(await resolveInRoot(this.root, "."), resolved)
      .split(sep)
      .join("/");
    if (normalized.split("/").includes(".git")) {
      throw new LocalAgentPathDeniedError(path);
    }
    return normalized.length === 0 ? "." : normalized;
  }

  private async trackedPaths(path = "."): Promise<Set<string>> {
    const args = ["-c", "core.fsmonitor=false", "ls-files", "-z"];
    if (path !== ".") args.push("--", path);
    const result = await super.exec({
      cmd: "git",
      args,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error("Could not resolve the local agent file boundary");
    }
    return new Set(
      result.stdout.split("\0").filter((entry) => entry.length > 0),
    );
  }

  private async assertReadable(path: string): Promise<string> {
    const normalized = await this.modelPath(path);
    const metadata = await lstat(await resolveInRoot(this.root, normalized));
    if (metadata.isSymbolicLink()) throw new LocalAgentPathDeniedError(path);
    if (this.ownedPaths.has(normalized)) return normalized;
    if ((await this.trackedPaths(normalized)).has(normalized))
      return normalized;
    throw new LocalAgentPathDeniedError(path);
  }

  private async assertWritable(path: string): Promise<string> {
    const normalized = await this.modelPath(path);
    try {
      const metadata = await lstat(await resolveInRoot(this.root, normalized));
      if (metadata.isSymbolicLink()) throw new LocalAgentPathDeniedError(path);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return normalized;
      }
      throw error;
    }
    await this.assertReadable(normalized);
    return normalized;
  }

  override async readFile(path: string): Promise<Uint8Array> {
    await this.assertReadable(path);
    return await super.readFile(path);
  }

  override async readFileForUpdate(
    path: string,
  ): Promise<WorkspaceFileSnapshot> {
    await this.assertReadable(path);
    return await super.readFileForUpdate(path);
  }

  override async writeFile(path: string, data: Uint8Array): Promise<void> {
    const normalized = await this.assertWritable(path);
    await super.writeFile(normalized, data);
    this.ownership?.apply({ add: [normalized], remove: [] });
    this.ownedPaths.add(normalized);
  }

  override async writeFilesAtomically(
    files: readonly AtomicFileWrite[],
  ): Promise<void> {
    const normalized = await Promise.all(
      files.map(async (file) => ({
        ...file,
        path: await this.assertWritable(file.path),
      })),
    );
    await super.writeFilesAtomically(normalized);
    this.ownership?.apply({
      add: normalized.map((file) => file.path),
      remove: [],
    });
    for (const file of normalized) this.ownedPaths.add(file.path);
  }

  override async listFiles(
    path: string,
    opts: { glob?: string; maxDepth?: number } = {},
  ): Promise<FileEntry[]> {
    const base = await this.modelPath(path);
    const [entries, tracked] = await Promise.all([
      super.listFiles(path, opts),
      this.trackedPaths(base),
    ]);
    const allowed = new Set([...tracked, ...this.ownedPaths]);
    return entries.filter((entry) => {
      const candidate = base === "." ? entry.path : `${base}/${entry.path}`;
      if (candidate.split("/").includes(".git")) return false;
      if (entry.type !== "directory") return allowed.has(candidate);
      const prefix = `${candidate}/`;
      return [...allowed].some((allowedPath) => allowedPath.startsWith(prefix));
    });
  }

  override async stat(path: string): Promise<FileStat> {
    await this.assertReadable(path);
    return await super.stat(path);
  }

  override async delete(path: string): Promise<void> {
    await this.deleteFile(path);
  }

  override async deleteFile(path: string): Promise<void> {
    const normalized = await this.assertReadable(path);
    await super.deleteFile(normalized);
    this.ownership?.apply({ add: [], remove: [normalized] });
    this.ownedPaths.delete(normalized);
  }

  override async renameFile(input: WorkspaceRenameInput): Promise<void> {
    const source = await this.assertReadable(input.source);
    const destination = await this.assertWritable(input.destination);
    await super.renameFile({ source, destination, overwrite: input.overwrite });
    this.ownership?.apply({ add: [destination], remove: [source] });
    this.ownedPaths.delete(source);
    this.ownedPaths.add(destination);
  }
}
