import process from 'node:process';
import { execa } from 'execa';
import * as nodePty from 'node-pty';
import { z } from 'zod';
import { MAX_EXEC_OUTPUT_BYTES, resolveInRoot } from '@zapp/workspace-runtime';

export const ExecRequestSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive(),
    pty: z.boolean().optional(),
  })
  .strict();

export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export const ExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().finite().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type ExecResult = z.infer<typeof ExecResultSchema>;

const StartedRecordSchema = z
  .object({ type: z.literal('started'), pid: z.number().int().positive(), at: z.string().datetime() })
  .strict();
const OutputRecordSchema = z
  .object({
    type: z.enum(['stdout', 'stderr']),
    data: z.string(),
    at: z.string().datetime(),
  })
  .strict();
const ExitRecordSchema = z
  .object({
    type: z.literal('exit'),
    exitCode: z.number().int(),
    durationMs: z.number().finite().nonnegative(),
    truncated: z.boolean(),
    at: z.string().datetime(),
  })
  .strict();

export const ExecStreamRecordSchema = z.discriminatedUnion('type', [
  StartedRecordSchema,
  OutputRecordSchema,
  ExitRecordSchema,
]);

export type ExecStreamRecord = z.infer<typeof ExecStreamRecordSchema>;

interface ActiveProcess {
  readonly kill: () => void;
  readonly done: Promise<void>;
}

interface OutputCollector {
  readonly append: (stream: 'stdout' | 'stderr', data: Buffer) => void;
  readonly result: () => Pick<ExecResult, 'stdout' | 'stderr' | 'truncated'>;
}

function createOutputCollector(emit?: (record: ExecStreamRecord) => void): OutputCollector {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let truncated = false;

  return {
    append(stream, data) {
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
      if (accepted.length > 0) {
        emit?.(
          ExecStreamRecordSchema.parse({
            type: stream,
            data: accepted.toString('utf8'),
            at: new Date().toISOString(),
          }),
        );
      }
    },
    result() {
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      };
    },
  };
}

function killProcessGroup(pid: number, fallback: () => void): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      fallback();
      return;
    }
  }
  fallback();
}

export class ExecManager {
  private readonly active = new Map<number, ActiveProcess>();

  constructor(private readonly workspaceRoot: string) {}

  async run(input: ExecRequest, emit?: (record: ExecStreamRecord) => void): Promise<ExecResult> {
    const cwd = await resolveInRoot(this.workspaceRoot, input.cwd ?? '.');
    return input.pty === true ? this.runPty(input, cwd, emit) : this.runProcess(input, cwd, emit);
  }

  kill(pid: number): boolean {
    const active = this.active.get(pid);
    if (active === undefined) {
      return false;
    }
    active.kill();
    return true;
  }

  async killAll(): Promise<void> {
    const active = [...this.active.values()];
    for (const child of active) {
      child.kill();
    }
    await Promise.allSettled(active.map(async (child) => child.done));
  }

  private async runProcess(
    input: ExecRequest,
    cwd: string,
    emit?: (record: ExecStreamRecord) => void,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const output = createOutputCollector(emit);
    const subprocess = execa(input.cmd, input.args, {
      cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      extendEnv: true,
      reject: false,
      buffer: false,
      cleanup: false,
      detached: process.platform !== 'win32',
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pid = subprocess.pid;
    if (pid === undefined) {
      throw new Error('Command did not start');
    }

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const kill = (): void => {
      killProcessGroup(pid, () => subprocess.kill('SIGKILL'));
    };
    this.active.set(pid, { kill, done });
    emit?.(
      ExecStreamRecordSchema.parse({ type: 'started', pid, at: new Date().toISOString() }),
    );

    subprocess.stdout?.on('data', (data: Buffer) => {
      output.append('stdout', data);
    });
    subprocess.stderr?.on('data', (data: Buffer) => {
      output.append('stderr', data);
    });
    const state = { timedOut: false };
    const timeout = setTimeout(() => {
      state.timedOut = true;
      kill();
    }, input.timeoutMs);

    try {
      const completed = await subprocess;
      const completedExitCode = (completed as { exitCode?: number }).exitCode;
      const result = ExecResultSchema.parse({
        exitCode: state.timedOut ? 124 : (completedExitCode ?? 137),
        durationMs: performance.now() - startedAt,
        ...output.result(),
      });
      emit?.(
        ExecStreamRecordSchema.parse({
          type: 'exit',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          at: new Date().toISOString(),
        }),
      );
      return result;
    } finally {
      clearTimeout(timeout);
      this.active.delete(pid);
      resolveDone();
    }
  }

  private runPty(
    input: ExecRequest,
    cwd: string,
    emit?: (record: ExecStreamRecord) => void,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const output = createOutputCollector(emit);
    const terminal = nodePty.spawn(input.cmd, input.args, {
      cwd,
      env: { ...process.env, ...input.env },
      cols: 80,
      rows: 24,
    });
    const pid = terminal.pid;
    emit?.(
      ExecStreamRecordSchema.parse({ type: 'started', pid, at: new Date().toISOString() }),
    );

    return new Promise<ExecResult>((resolve) => {
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((resolveActive) => {
        resolveDone = resolveActive;
      });
      const kill = (): void => {
        killProcessGroup(pid, () => {
          terminal.kill('SIGKILL');
        });
      };
      this.active.set(pid, { kill, done });
      const state = { timedOut: false };
      const timeout = setTimeout(() => {
        state.timedOut = true;
        kill();
      }, input.timeoutMs);
      terminal.onData((data) => {
        output.append('stdout', Buffer.from(data));
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        this.active.delete(pid);
        const result = ExecResultSchema.parse({
          exitCode: state.timedOut ? 124 : exitCode,
          durationMs: performance.now() - startedAt,
          ...output.result(),
        });
        emit?.(
          ExecStreamRecordSchema.parse({
            type: 'exit',
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated,
            at: new Date().toISOString(),
          }),
        );
        resolveDone();
        resolve(result);
      });
    });
  }
}
