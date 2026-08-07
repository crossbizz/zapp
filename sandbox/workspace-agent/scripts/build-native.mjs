import { chmod, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeSource = join(packageRoot, 'native');
const outputDirectory = join(packageRoot, 'dist', 'native');
const compiler = process.env.CC ?? 'cc';
const compilerFlags = ['-std=c11', '-Wall', '-Wextra', '-Wpedantic', '-O2'];

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} exited with ${String(exitCode)}`));
    });
  });
}

await mkdir(outputDirectory, { recursive: true });
for (const executable of ['path-helper', 'exec-launcher']) {
  const source = join(nativeSource, `${executable}.c`);
  const output = join(outputDirectory, executable);
  await run(compiler, [...compilerFlags, source, '-o', output]);
  await chmod(output, 0o755);
}
