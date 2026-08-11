import { spawn } from 'node:child_process';

export interface GitCommandInput {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface GitCommandRunner {
  run(input: GitCommandInput): Promise<{ stdout: string }>;
}

export class GitCommandExecutionError extends Error {
  constructor(readonly kind: 'failed' | 'timeout' | 'output_limit') {
    super(`git command ${kind}`);
    this.name = 'GitCommandExecutionError';
  }
}

function inheritedProcessEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'] as const) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

/** Executes token-free Git argv with bounded time and bounded captured output. */
export function createGitCommandRunner(maxOutputBytes = 1024 * 1024): GitCommandRunner {
  return {
    run(input) {
      return new Promise((resolve, reject) => {
        const child = spawn('git', [...input.args], {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          // Do not hand the Git subprocess the service's unrelated credentials.
          // The only secrets it receives are the one askpass password selected
          // by the caller for this exact source or target operation.
          env: { ...inheritedProcessEnvironment(), ...input.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (error?: Error, result?: { stdout: string }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined) reject(error);
          else resolve(result ?? { stdout: '' });
        };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new GitCommandExecutionError('timeout'));
        }, input.timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) {
            child.kill('SIGKILL');
            finish(new GitCommandExecutionError('output_limit'));
            return;
          }
          stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) {
            child.kill('SIGKILL');
            finish(new GitCommandExecutionError('output_limit'));
          }
          // Deliberately discarded. A remote can echo a credential supplied by
          // askpass; provider text must never become an exception or log value.
        });
        child.once('error', () => {
          finish(new GitCommandExecutionError('failed'));
        });
        child.once('close', (code) => {
          if (code !== 0) {
            finish(new GitCommandExecutionError('failed'));
            return;
          }
          finish(undefined, { stdout: Buffer.concat(stdout).toString('utf8') });
        });
      });
    },
  };
}
