import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createNextDevOutputName,
  defaultNextDevOutputDirectory,
  nextDevWatchEnvironment,
  preserveNextGeneratedFiles,
  resetNextDevOutput,
} from '../e2e/support/next-dev-output.js';

const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

void test('removes only the selected app Next output before dev startup', async () => {
  const appDirectory = await mkdtemp(join(tmpdir(), 'zapp-web-next-output-'));
  fixtureDirectories.push(appDirectory);

  const nextOutputDirectory = join(appDirectory, '.next');
  const nextOutputFile = join(nextOutputDirectory, 'server', 'build-manifest.json');
  const siblingFile = join(appDirectory, 'source.ts');
  await mkdir(join(nextOutputDirectory, 'server'), { recursive: true });
  await writeFile(nextOutputFile, '{}', 'utf8');
  await writeFile(siblingFile, 'keep', 'utf8');

  await resetNextDevOutput(nextOutputDirectory);

  await assert.rejects(access(nextOutputDirectory), { code: 'ENOENT' });
  assert.equal(await readFile(siblingFile, 'utf8'), 'keep');
});

void test('defaults to the absolute web app Next output directory', () => {
  const webAppDirectory = fileURLToPath(new URL('../', import.meta.url));

  assert.equal(isAbsolute(defaultNextDevOutputDirectory), true);
  assert.equal(defaultNextDevOutputDirectory, join(webAppDirectory, '.next'));
});

void test('uses polling for repository-scale local and E2E Next watchers', () => {
  assert.deepEqual(nextDevWatchEnvironment(), { WATCHPACK_POLLING: 'true' });
});

void test('gives every E2E server run its own Next output directory', () => {
  const first = createNextDevOutputName(3100);
  const second = createNextDevOutputName(3100);

  assert.match(first, /^\.next-e2e-3100-[a-f0-9-]+$/u);
  assert.match(second, /^\.next-e2e-3100-[a-f0-9-]+$/u);
  assert.notEqual(first, second);
});

void test('restores tracked files that Next rewrites during an isolated dev run', async () => {
  const appDirectory = await mkdtemp(join(tmpdir(), 'zapp-web-next-generated-'));
  fixtureDirectories.push(appDirectory);

  const nextEnvPath = join(appDirectory, 'next-env.d.ts');
  const tsconfigPath = join(appDirectory, 'tsconfig.json');
  await writeFile(nextEnvPath, 'tracked next env\n', 'utf8');
  await writeFile(tsconfigPath, '{"include":[]}\n', 'utf8');

  const restore = await preserveNextGeneratedFiles([nextEnvPath, tsconfigPath]);
  await writeFile(nextEnvPath, 'rewritten next env\n', 'utf8');
  await writeFile(tsconfigPath, '{"include":[".next-e2e/types"]}\n', 'utf8');

  await restore();

  assert.equal(await readFile(nextEnvPath, 'utf8'), 'tracked next env\n');
  assert.equal(await readFile(tsconfigPath, 'utf8'), '{"include":[]}\n');
});
