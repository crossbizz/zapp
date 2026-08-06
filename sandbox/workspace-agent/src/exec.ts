import process from 'node:process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import * as nodePty from 'node-pty';
import { z } from 'zod';
import { MAX_EXEC_OUTPUT_BYTES, PathViolationError, resolveInRoot } from '@zapp/workspace-runtime';
import { createProductionContainment } from './containment/cgroup.js';
import {
  ContainmentCleanupError,
  ContainmentUnavailableError,
  type Containment,
  type ContainmentTerminationReason,
  type ExecutionContainment,
} from './containment/types.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC_LAUNCHER = join(PACKAGE_ROOT, 'dist', 'native', 'exec-launcher');
const PATH_HELPER_PATH_VIOLATION = 65;
const PATH_HELPER_CONTAINMENT_FAILURE = 75;

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
  'ZAPP_CGROUP_ROOT',
]);
const MAX_STREAM_RECORD_BYTES = 8 * 1_024;
const STREAM_RECORD_FLUSH_DELAY_MS = 25;
const NoNulStringSchema = z.string().refine((value) => !value.includes('\0'), 'NUL is not allowed');

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
    cmd: z
      .string()
      .min(1)
      .refine((value) => !value.includes('\0'), 'NUL is not allowed'),
    args: z.array(NoNulStringSchema),
    cwd: NoNulStringSchema.optional(),
    env: RequestEnvSchema.optional(),
    timeoutMs: z.number().int().positive(),
    pty: z.boolean().optional(),
  })
  .strict();

export type ExecRequest = z.infer<typeof ExecRequestSchema>;

function buildChildEnv(
  requestEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
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
  .object({
    type: z.literal('started'),
    pid: z.number().int().positive(),
    at: z.string().datetime(),
  })
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
  readonly containment: ExecutionContainment;
  readonly kill: (reason: ContainmentTerminationReason) => void;
  readonly done: Promise<void>;
  finish(): void;
}

interface CleanupReceipt {
  readonly completion: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
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

  const setAppendChain = (next: Promise<void>): Promise<void> => {
    appendChain = next;
    // A timer may flush after the HTTP writer has closed. Keep the rejection
    // on the chain for result()/the execution path, while observing it here so
    // Node never reports a transient unhandled rejection first.
    void next.catch(() => undefined);
    return next;
  };

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
      void setAppendChain(appendChain.then(flushPending));
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
      return setAppendChain(
        appendChain.then(async () => appendText(stream, decoders[stream].write(data))),
      );
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

function launcherArgs(
  workspaceRoot: string,
  cwd: string,
  containment: ExecutionContainment,
  input: ExecRequest,
): string[] {
  return [
    '--workspace-root',
    workspaceRoot,
    '--cwd',
    cwd,
    '--cgroup-procs',
    containment.procsPath,
    '--',
    input.cmd,
    ...input.args,
  ];
}

async function assertExecutable(
  command: string,
  checkedCwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(checkedCwd, command)]
    : (environment.PATH ?? '/usr/bin:/bin')
        .split(delimiter)
        .filter((directory) => directory.length > 0)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch {
      // Try the next PATH entry. The native launcher remains authoritative at exec time.
    }
  }
  throw new ExecPreflightError();
}

export class ExecManager {
  private readonly active = new Map<number, ActiveProcess>();
  private readonly owned = new Set<ActiveProcess>();
  private readonly cleanupReceipts = new Map<string, CleanupReceipt>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly containment: Containment = createProductionContainment(),
  ) {}

  activeProcessGroups(): readonly number[] {
    return [...new Set([...this.owned].map((child) => child.processGroupId))];
  }

  activeContainmentCount(): number {
    return this.owned.size;
  }

  async run(input: ExecRequest, emit?: ExecStreamEmitter, cleanupId?: string): Promise<ExecResult> {
    const receipt = cleanupId === undefined ? undefined : this.reserveCleanup(cleanupId);
    try {
      const cwd = input.cwd ?? '.';
      const checkedCwd = await resolveInRoot(this.workspaceRoot, cwd);
      const environment = buildChildEnv(input.env);
      await assertExecutable(input.cmd, checkedCwd, environment);
      const containment = await this.containment.create();
      return await (input.pty === true
        ? this.runPty(input, cwd, environment, containment, emit, receipt)
        : this.runProcess(input, cwd, environment, containment, emit, receipt));
    } catch (error) {
      receipt?.reject(error instanceof Error ? error : new Error('Execution failed'));
      throw error;
    }
  }

  async acknowledgeCleanup(cleanupId: string): Promise<boolean> {
    const receipt = this.cleanupReceipts.get(cleanupId);
    if (receipt === undefined) {
      return false;
    }
    try {
      await receipt.completion;
      return true;
    } catch {
      throw new ContainmentCleanupError();
    } finally {
      if (this.cleanupReceipts.get(cleanupId) === receipt) {
        this.cleanupReceipts.delete(cleanupId);
      }
    }
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
    const active = [...this.owned];
    for (const child of active) {
      child.kill('shutdown');
    }
    const outcomes = await Promise.allSettled(active.map(async (child) => child.done));
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new ContainmentCleanupError();
    }
  }

  private reserveCleanup(cleanupId: string): CleanupReceipt {
    if (this.cleanupReceipts.has(cleanupId) || this.cleanupReceipts.size >= 256) {
      throw new ExecPreflightError();
    }
    let resolveCompletion: () => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    let settled = false;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);
    const receipt: CleanupReceipt = {
      completion,
      resolve() {
        if (!settled) {
          settled = true;
          resolveCompletion();
        }
      },
      reject(error) {
        if (!settled) {
          settled = true;
          rejectCompletion(error);
        }
      },
    };
    this.cleanupReceipts.set(cleanupId, receipt);
    return receipt;
  }

  private beginActive(
    pid: number,
    containment: ExecutionContainment,
  ): {
    readonly active: ActiveProcess;
    readonly state: { termination: ContainmentTerminationReason | undefined };
  } {
    let resolveDone: () => void = () => undefined;
    let rejectDone: (error: Error) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => undefined);
    const state = { termination: undefined as ContainmentTerminationReason | undefined };
    let killPromise: Promise<void> | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      this.active.delete(pid);
      void (async () => {
        try {
          await killPromise;
          try {
            await containment.waitForEmpty();
          } catch {
            await containment.kill();
            await containment.waitForEmpty();
          }
          await containment.remove();
          this.owned.delete(active);
          resolveDone();
        } catch (error) {
          rejectDone(error instanceof Error ? error : new Error('Containment cleanup failed'));
        }
      })();
    };
    const active: ActiveProcess = {
      processGroupId: pid,
      containment,
      kill(reason) {
        if (state.termination !== undefined) {
          return;
        }
        state.termination = reason;
        killPromise = containment.kill();
        void killPromise.catch(() => undefined);
      },
      done,
      finish,
    };
    this.active.set(pid, active);
    this.owned.add(active);
    return { active, state };
  }

  private async discardUnstarted(containment: ExecutionContainment): Promise<void> {
    try {
      await containment.waitForEmpty();
      await containment.remove();
    } catch {
      // The original launch error is more actionable than a cleanup failure.
    }
  }

  private async runProcess(
    input: ExecRequest,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    containment: ExecutionContainment,
    emit?: ExecStreamEmitter,
    cleanupReceipt?: CleanupReceipt,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const output = createOutputCollector(emit);
    const subprocess = execa(
      EXEC_LAUNCHER,
      launcherArgs(this.workspaceRoot, cwd, containment, input),
      {
        env: environment,
        extendEnv: false,
        reject: false,
        buffer: false,
        cleanup: false,
        detached: process.platform !== 'win32',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const pid = subprocess.pid;
    const stdout = subprocess.stdout;
    const stderr = subprocess.stderr;
    if (pid === undefined) {
      void subprocess.catch(() => undefined);
      await this.discardUnstarted(containment);
      throw new ExecPreflightError();
    }
    if (stdout === null || stderr === null) {
      await this.discardUnstarted(containment);
      throw new ExecPreflightError();
    }
    const { active, state } = this.beginActive(pid, containment);
    if (cleanupReceipt !== undefined) {
      void active.done.then(
        () => {
          cleanupReceipt.resolve();
        },
        (error: unknown) => {
          cleanupReceipt.reject(
            error instanceof Error ? error : new Error('Containment cleanup failed'),
          );
        },
      );
    }
    // The PID route owns only the launcher process.  Its numeric identity must
    // disappear as soon as that process exits, even when HTTP output delivery
    // remains backpressured.  The separate containment ownership stays alive
    // until cgroup.events reports populated 0.
    const processCompletion = Promise.resolve(subprocess).finally(() => {
      active.finish();
    });
    const timeout = setTimeout(() => {
      active.kill('timeout');
    }, input.timeoutMs);

    try {
      await emit?.(
        ExecStreamRecordSchema.parse({ type: 'started', pid, at: new Date().toISOString() }),
      );
      const [completed] = await Promise.all([
        processCompletion,
        consumeOutputChunks(stdout, async (data) => output.append('stdout', data)),
        consumeOutputChunks(stderr, async (data) => output.append('stderr', data)),
      ]);
      const completedExitCode = (completed as { exitCode?: number }).exitCode;
      if (
        completedExitCode === PATH_HELPER_CONTAINMENT_FAILURE &&
        state.termination === undefined
      ) {
        throw new ContainmentUnavailableError();
      }
      if (completedExitCode === PATH_HELPER_PATH_VIOLATION && state.termination === undefined) {
        throw new PathViolationError(cwd);
      }
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
      active.kill('disconnect');
      await Promise.allSettled([processCompletion]);
      throw error;
    } finally {
      clearTimeout(timeout);
      active.finish();
    }
  }

  private async runPty(
    input: ExecRequest,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    containment: ExecutionContainment,
    emit?: ExecStreamEmitter,
    cleanupReceipt?: CleanupReceipt,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const output = createOutputCollector(emit);
    let terminal: nodePty.IPty;
    try {
      terminal = nodePty.spawn(
        EXEC_LAUNCHER,
        launcherArgs(this.workspaceRoot, cwd, containment, input),
        {
          env: environment,
          cols: 80,
          rows: 24,
        },
      );
    } catch {
      await this.discardUnstarted(containment);
      throw new ExecPreflightError();
    }
    const pid = terminal.pid;
    terminal.pause();
    const { active, state } = this.beginActive(pid, containment);
    if (cleanupReceipt !== undefined) {
      void active.done.then(
        () => {
          cleanupReceipt.resolve();
        },
        (error: unknown) => {
          cleanupReceipt.reject(
            error instanceof Error ? error : new Error('Containment cleanup failed'),
          );
        },
      );
    }
    const timeout = setTimeout(() => {
      active.kill('timeout');
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
          active.kill('disconnect');
        });
    });
    const completion = new Promise<ExecResult>((resolve, reject) => {
      terminal.onExit(({ exitCode }) => {
        active.finish();
        void (async () => {
          await outputChain;
          if (outputError !== undefined) {
            throw outputError;
          }
          clearTimeout(timeout);
          if (exitCode === PATH_HELPER_CONTAINMENT_FAILURE && state.termination === undefined) {
            throw new ContainmentUnavailableError();
          }
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
          resolve(result);
        })().catch((error: unknown) => {
          clearTimeout(timeout);
          active.finish();
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
      active.kill('disconnect');
      await Promise.allSettled([completion]);
      throw error;
    }
  }
}
