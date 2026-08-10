import { exec as execBundledGit } from "dugite";
import { spawn as spawnPty } from "node-pty";
import {
  MAX_EXEC_OUTPUT_BYTES,
  MemoryWorkspaceRuntime,
  resolveInRoot,
  type ExecResult,
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
