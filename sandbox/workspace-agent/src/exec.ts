import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { execa } from 'execa';
import * as nodePty from 'node-pty';
import { z } from 'zod';
import { MAX_EXEC_OUTPUT_BYTES, resolveInRoot } from '@zapp/workspace-runtime';

const SAFE_INHERITED_ENV_NAMES = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'USER',
  'LOGNAME',
] as const;

const RESERVED_AGENT_ENV_NAMES = new Set([
  'ZAPP_AGENT_TOKEN',
  'ZAPP_WORKSPACE_ROOT',
  'ZAPP_DEV_SERVER_PORT',
]);
const MAX_STREAM_RECORD_BYTES = 8 * 1_024;
const STREAM_RECORD_FLUSH_DELAY_MS = 5;
const NoNulStringSchema = z
  .string()
  .refine((value) => !value.includes('\0'), 'NUL is not allowed');

const RequestEnvSchema = z.record(z.string()).superRefine((env, context) => {
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid environment name' });
    }
    if (RESERVED_AGENT_ENV_NAMES.has(name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Reserved environment name' });
    }
    if (value.includes('\0')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid environment value' });
    }
  }
});

export const ExecRequestSchema = z
  .object({
    cmd: z.string().min(1).refine((value) => !value.includes('\0'), 'NUL is not allowed'),
    args: z.array(NoNulStringSchema),
    cwd: NoNulStringSchema.optional(),
    env: RequestEnvSchema.optional(),
    timeoutMs: z.number().int().positive(),
    pty: z.boolean().optional(),
  })
  .strict();

export type ExecRequest = z.infer<typeof ExecRequestSchema>;

function buildChildEnv(requestEnv: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of SAFE_INHERITED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }
  return { ...childEnv, ...requestEnv };
}

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

export class ExecPreflightError extends Error {
  constructor() {
    super('Command could not be started');
    this.name = 'ExecPreflightError';
  }
}

interface ActiveProcess {
  readonly processGroupId: number;
  readonly kill: (reason: 'disconnect' | 'explicit' | 'shutdown' | 'timeout') => void;
  readonly done: Promise<void>;
}

type ExecStreamEmitter = (record: ExecStreamRecord) => Promise<void> | void;

interface OutputCollector {
  readonly append: (stream: 'stdout' | 'stderr', data: Buffer) => Promise<void>;
  readonly result: () => Promise<Pick<ExecResult, 'stdout' | 'stderr' | 'truncated'>>;
}

export async function consumeOutputChunks(
  source: AsyncIterable<Buffer | string>,
  append: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  for await (const chunk of source) {
    await append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function createOutputCollector(emit?: ExecStreamEmitter): OutputCollector {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  let outputBytes = 0;
  let truncated = false;
  let prefixClosed = false;
  let finalized = false;
  let appendChain = Promise.resolve();
  let pendingStream: 'stdout' | 'stderr' | undefined;
  let pendingText = '';
  let pendingBytes = 0;
  let flushTimer: NodeJS.Timeout | undefined;

  const flushPending = async (): Promise<void> => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (pendingStream === undefined || pendingText.length === 0) {
      return;
    }
    const stream = pendingStream;
    const data = pendingText;
    pendingStream = undefined;
    pendingText = '';
    pendingBytes = 0;
    await emit?.(
      ExecStreamRecordSchema.parse({
        type: stream,
        data,
        at: new Date().toISOString(),
      }),
    );
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      appendChain = appendChain.then(flushPending);
    }, STREAM_RECORD_FLUSH_DELAY_MS);
  };

  const emitText = async (stream: 'stdout' | 'stderr', text: string): Promise<void> => {
    if (emit === undefined || text.length === 0) {
      return;
    }
    if (pendingStream !== undefined && pendingStream !== stream) {
      await flushPending();
    }
    pendingStream = stream;
    pendingText += text;
    pendingBytes += Buffer.byteLength(text);
    if (pendingBytes >= MAX_STREAM_RECORD_BYTES) {
      await flushPending();
    } else {
      scheduleFlush();
    }
  };

  const validUtf8Prefix = (text: string, maxBytes: number): string => {
    const encoded = Buffer.from(text, 'utf8');
    if (encoded.length <= maxBytes) {
      return text;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let end = maxBytes;
    while (end > 0) {
      try {
        return decoder.decode(encoded.subarray(0, end));
      } catch {
        end -= 1;
      }
    }
    return '';
  };

  const appendText = async (stream: 'stdout' | 'stderr', text: string): Promise<void> => {
    if (text.length === 0 || prefixClosed) {
      return;
    }
    const remaining = MAX_EXEC_OUTPUT_BYTES - outputBytes;
    if (remaining <= 0) {
      truncated = true;
      prefixClosed = true;
      return;
    }
    const accepted = validUtf8Prefix(text, remaining);
    if (accepted !== text) {
      truncated = true;
      prefixClosed = true;
    }
    outputBytes += Buffer.byteLength(accepted);
    if (accepted.length === 0) {
      return;
    }
    (stream === 'stdout' ? stdout : stderr).push(accepted);
    await emitText(stream, accepted);
  };

  const finalize = async (): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;
    await appendText('stdout', decoders.stdout.end());
    await appendText('stderr', decoders.stderr.end());
    await flushPending();
  };

  return {
    append(stream, data) {
      appendChain = appendChain.then(async () =>
        appendText(stream, decoders[stream].write(data)),
      );
      return appendChain;
    },
    async result() {
      await appendChain;
      await finalize();
      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
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

  activeProcessGroups(): readonly number[] {
    return [...new Set([...this.active.values()].map((child) => child.processGroupId))];
  }

  async run(input: ExecRequest, emit?: ExecStreamEmitter): Promise<ExecResult> {
    const cwd = await resolveInRoot(this.workspaceRoot, input.cwd ?? '.');
    return input.pty === true ? this.runPty(input, cwd, emit) : this.runProcess(input, cwd, emit);
  }

  kill(pid: number): boolean {
    const active = this.active.get(pid);
    if (active === undefined) {
      return false;
    }
    active.kill('explicit');
    return true;
  }

  async killAll(): Promise<void> {
    const active = [...this.active.values()];
    for (const child of active) {
      child.kill('shutdown');
    }
    await Promise.allSettled(active.map(async (child) => child.done));
  }

  private async runProcess(
    input: ExecRequest,
    cwd: string,
    emit?: ExecStreamEmitter,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const output = createOutputCollector(emit);
    const subprocess = execa(input.cmd, input.args, {
      cwd,
      env: buildChildEnv(input.env),
      extendEnv: false,
      reject: false,
      buffer: false,
      cleanup: false,
      detached: process.platform !== 'win32',
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pid = subprocess.pid;
    const stdout = subprocess.stdout;
    const stderr = subprocess.stderr;
    if (pid === undefined) {
      void subprocess.catch(() => undefined);
      throw new ExecPreflightError();
    }
    if (stdout === null || stderr === null) {
      subprocess.kill('SIGKILL');
      throw new ExecPreflightError();
    }

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const state = {
      termination: undefined as 'disconnect' | 'explicit' | 'shutdown' | 'timeout' | undefined,
    };
    const kill = (reason: 'disconnect' | 'explicit' | 'shutdown' | 'timeout'): void => {
      state.termination ??= reason;
      killProcessGroup(pid, () => subprocess.kill('SIGKILL'));
    };
    this.active.set(pid, { processGroupId: pid, kill, done });
    const timeout = setTimeout(() => {
      kill('timeout');
    }, input.timeoutMs);

    try {
      await emit?.(
        ExecStreamRecordSchema.parse({ type: 'started', pid, at: new Date().toISOString() }),
      );
      const [completed] = await Promise.all([
        subprocess,
        consumeOutputChunks(stdout, async (data) => output.append('stdout', data)),
        consumeOutputChunks(stderr, async (data) => output.append('stderr', data)),
      ]);
      const completedExitCode = (completed as { exitCode?: number }).exitCode;
      const result = ExecResultSchema.parse({
        exitCode:
          state.termination === 'timeout'
            ? 124
            : state.termination === undefined
              ? (completedExitCode ?? 137)
              : 137,
        durationMs: performance.now() - startedAt,
        ...(await output.result()),
      });
      await emit?.(
        ExecStreamRecordSchema.parse({
          type: 'exit',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          at: new Date().toISOString(),
        }),
      );
      return result;
    } catch (error) {
      kill('disconnect');
      await Promise.allSettled([subprocess]);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.active.delete(pid);
      resolveDone();
    }
  }

  private async runPty(
    input: ExecRequest,
    cwd: string,
    emit?: ExecStreamEmitter,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const output = createOutputCollector(emit);
    let terminal: nodePty.IPty;
    try {
      terminal = nodePty.spawn(input.cmd, input.args, {
        cwd,
        env: buildChildEnv(input.env),
        cols: 80,
        rows: 24,
      });
    } catch {
      throw new ExecPreflightError();
    }
    const pid = terminal.pid;
    terminal.pause();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolveActive) => {
      resolveDone = resolveActive;
    });
    const state = {
      termination: undefined as 'disconnect' | 'explicit' | 'shutdown' | 'timeout' | undefined,
    };
    const kill = (reason: 'disconnect' | 'explicit' | 'shutdown' | 'timeout'): void => {
      state.termination ??= reason;
      killProcessGroup(pid, () => {
        terminal.kill('SIGKILL');
      });
    };
    this.active.set(pid, { processGroupId: pid, kill, done });
    const timeout = setTimeout(() => {
      kill('timeout');
    }, input.timeoutMs);
    let outputChain = Promise.resolve();
    let outputError: Error | undefined;
    terminal.onData((data) => {
      terminal.pause();
      outputChain = outputChain
        .then(async () => output.append('stdout', Buffer.from(data)))
        .then(() => {
          terminal.resume();
        })
        .catch((error: unknown) => {
          outputError = error instanceof Error ? error : new Error('Output streaming failed');
          kill('disconnect');
        });
    });
    const completion = new Promise<ExecResult>((resolve, reject) => {
      terminal.onExit(({ exitCode }) => {
        void (async () => {
          await outputChain;
          if (outputError !== undefined) {
            throw outputError;
          }
          clearTimeout(timeout);
          this.active.delete(pid);
          const result = ExecResultSchema.parse({
            exitCode:
              state.termination === 'timeout'
                ? 124
                : state.termination === undefined
                  ? exitCode
                  : 137,
            durationMs: performance.now() - startedAt,
            ...(await output.result()),
          });
          await emit?.(
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
        })().catch((error: unknown) => {
          clearTimeout(timeout);
          this.active.delete(pid);
          resolveDone();
          reject(error instanceof Error ? error : new Error('PTY execution failed'));
        });
      });
    });

    try {
      await emit?.(
        ExecStreamRecordSchema.parse({ type: 'started', pid, at: new Date().toISOString() }),
      );
      terminal.resume();
      return await completion;
    } catch (error) {
      kill('disconnect');
      await Promise.allSettled([completion]);
      throw error;
    }
  }
}
