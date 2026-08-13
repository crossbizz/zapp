import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  defaultNextDevOutputDirectory,
  resetNextDevOutput,
} from '../e2e/support/next-dev-output.js';

const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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
