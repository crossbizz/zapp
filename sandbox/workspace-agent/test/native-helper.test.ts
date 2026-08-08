import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as nodePty from 'node-pty';
import { describe, expect, test } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATH_HELPER = join(PACKAGE_ROOT, 'dist', 'native', 'path-helper');
const EXEC_LAUNCHER = join(PACKAGE_ROOT, 'dist', 'native', 'exec-launcher');

interface SwapFixture {
  readonly fixtureRoot: string;
  readonly workspaceRoot: string;
  readonly outsideRoot: string;
  readonly parent: string;
  readonly pinnedParent: string;
  readonly readyPath: string;
  readonly continuePath: string;
}

interface NativeRun {
  readonly completion: Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>;
  readonly kill: () => void;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error(`Timed out waiting for native helper pause at ${path}`);
}

function runNative(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: Buffer,
): NativeRun {
  const child = spawn(executable, args, {
    env: environment,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    child.kill('SIGKILL');
    const completion = Promise.reject(new Error('Native helper did not expose output pipes'));
    void completion.catch(() => undefined);
    return { completion, kill: () => child.kill('SIGKILL') };
  }
  stdoutStream.on('data', (chunk: Buffer) => stdout.push(chunk));
  stderrStream.on('data', (chunk: Buffer) => stderr.push(chunk));
  const completion = new Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>(
    (resolveCompletion, rejectCompletion) => {
      child.once('error', rejectCompletion);
      child.once('close', (exitCode) => {
        resolveCompletion({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    },
  );
  void completion.catch(() => undefined);
  if (input !== undefined) {
    child.stdin?.end(input);
  }
  return { completion, kill: () => child.kill('SIGKILL') };
}

function runPathHelper(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: Buffer,
): NativeRun {
  return runNative(PATH_HELPER, args, environment, input);
}

function runExecLauncher(args: readonly string[], environment: NodeJS.ProcessEnv): NativeRun {
  return runNative(EXEC_LAUNCHER, args, environment);
}

function runPtyExecLauncher(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): {
  readonly completion: Promise<{ exitCode: number; output: string }>;
  readonly kill: () => void;
} {
  const terminal = nodePty.spawn(EXEC_LAUNCHER, [...args], {
    env: environment,
    cols: 80,
    rows: 24,
  });
  let output = '';
  terminal.onData((data) => {
    output += data;
  });
  return {
    completion: new Promise((resolveCompletion) => {
      terminal.onExit(({ exitCode }) => {
        resolveCompletion({ exitCode, output });
      });
    }),
    kill: () => {
      terminal.kill('SIGKILL');
    },
  };
}

async function createSwapFixture(prefix: string): Promise<SwapFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), prefix));
  const workspaceRoot = join(fixtureRoot, 'workspace');
  const outsideRoot = join(fixtureRoot, 'outside');
  const parent = join(workspaceRoot, 'parent');
  const pinnedParent = join(workspaceRoot, 'pinned-parent');
  await mkdir(parent, { recursive: true });
  await mkdir(outsideRoot);
  return {
    fixtureRoot,
    workspaceRoot,
    outsideRoot,
    parent,
    pinnedParent,
    readyPath: join(fixtureRoot, 'helper-ready'),
    continuePath: join(fixtureRoot, 'helper-continue'),
  };
}

function pauseEnvironment(fixture: SwapFixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ZAPP_NATIVE_TEST_READY_PATH: fixture.readyPath,
    ZAPP_NATIVE_TEST_CONTINUE_PATH: fixture.continuePath,
  };
}

async function waitForNativePause(run: NativeRun, fixture: SwapFixture): Promise<void> {
  await Promise.race([
    waitForPath(fixture.readyPath),
    run.completion.then(() => {
      throw new Error('Native helper exited before reaching the descriptor pause');
    }),
  ]);
}

async function swapParent(fixture: SwapFixture): Promise<void> {
  await rename(fixture.parent, fixture.pinnedParent);
  await symlink(fixture.outsideRoot, fixture.parent, 'dir');
  await writeFile(fixture.continuePath, 'continue');
}

describe('descriptor-relative native workspace helpers', () => {
  test('accepts the real Linux node-pty install shape without a macOS-only spawn helper', async () => {
    const scriptUrl = pathToFileURL(
      join(PACKAGE_ROOT, 'scripts', 'ensure-node-pty-helper.mjs'),
    ).href;
    const validation = runNative(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `Object.defineProperty(process, 'platform', { value: 'linux' }); await import(${JSON.stringify(scriptUrl)});`,
      ],
      process.env,
    );

    const result = await validation.completion;
    expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
  });

  test('build emits executable native helper and launcher binaries', async () => {
    await expect(access(PATH_HELPER, constants.X_OK)).resolves.toBeUndefined();
    await expect(access(EXEC_LAUNCHER, constants.X_OK)).resolves.toBeUndefined();
  });

  test('reads from the pinned parent descriptor after its pathname is swapped to an outside symlink', async () => {
    const fixture = await createSwapFixture('zapp-native-path-read-');
    await writeFile(join(fixture.parent, 'secret.txt'), 'inside');
    await writeFile(join(fixture.outsideRoot, 'secret.txt'), 'outside');

    const helper = runPathHelper(
      ['read', fixture.workspaceRoot, 'parent/secret.txt'],
      pauseEnvironment(fixture),
    );

    try {
      await waitForNativePause(helper, fixture);
      await swapParent(fixture);

      const result = await helper.completion;
      expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
      expect(result.stdout.toString('utf8')).toBe('inside');
      expect(await readFile(join(fixture.outsideRoot, 'secret.txt'), 'utf8')).toBe('outside');
    } finally {
      helper.kill();
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  test('writes through the pinned parent descriptor after its pathname is swapped to an outside symlink', async () => {
    const fixture = await createSwapFixture('zapp-native-path-write-');
    const helper = runPathHelper(
      ['write', fixture.workspaceRoot, 'parent/written.txt'],
      pauseEnvironment(fixture),
      Buffer.from('inside'),
    );

    try {
      await waitForNativePause(helper, fixture);
      await swapParent(fixture);

      const result = await helper.completion;
      expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
      expect(await readFile(join(fixture.pinnedParent, 'written.txt'), 'utf8')).toBe('inside');
      await expect(access(join(fixture.outsideRoot, 'written.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      helper.kill();
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  test('lists the pinned directory after its pathname is swapped to an outside symlink', async () => {
    const fixture = await createSwapFixture('zapp-native-path-list-');
    await writeFile(join(fixture.parent, 'inside.txt'), 'inside');
    await writeFile(join(fixture.outsideRoot, 'outside.txt'), 'outside');
    const helper = runPathHelper(
      ['list', fixture.workspaceRoot, 'parent', '0'],
      pauseEnvironment(fixture),
    );

    try {
      await waitForNativePause(helper, fixture);
      await swapParent(fixture);

      const result = await helper.completion;
      expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
      expect(result.stdout).toEqual(Buffer.from('finside.txt\0'));
    } finally {
      helper.kill();
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  test('runs buffered commands from the pinned cwd after its pathname is swapped to an outside symlink', async () => {
    const fixture = await createSwapFixture('zapp-native-exec-buffered-');
    const launcher = runExecLauncher(
      [
        '--workspace-root',
        fixture.workspaceRoot,
        '--cwd',
        'parent',
        '--',
        '/bin/sh',
        '-c',
        'printf pinned > buffered.txt',
      ],
      pauseEnvironment(fixture),
    );

    try {
      await waitForNativePause(launcher, fixture);
      await swapParent(fixture);

      const result = await launcher.completion;
      expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
      expect(await readFile(join(fixture.pinnedParent, 'buffered.txt'), 'utf8')).toBe('pinned');
      await expect(access(join(fixture.outsideRoot, 'buffered.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      launcher.kill();
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  test('runs PTY commands from the pinned cwd after its pathname is swapped to an outside symlink', async () => {
    const fixture = await createSwapFixture('zapp-native-exec-pty-');
    const terminal = runPtyExecLauncher(
      [
        '--workspace-root',
        fixture.workspaceRoot,
        '--cwd',
        'parent',
        '--',
        '/bin/sh',
        '-c',
        'printf pinned > pty.txt',
      ],
      pauseEnvironment(fixture),
    );

    try {
      await Promise.race([
        waitForPath(fixture.readyPath),
        terminal.completion.then(() => {
          throw new Error('Native launcher exited before reaching the descriptor pause');
        }),
      ]);
      await swapParent(fixture);

      const result = await terminal.completion;
      expect(result.exitCode, result.output).toBe(0);
      expect(await readFile(join(fixture.pinnedParent, 'pty.txt'), 'utf8')).toBe('pinned');
      await expect(access(join(fixture.outsideRoot, 'pty.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      terminal.kill();
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
