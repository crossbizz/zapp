import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DetectionContext } from '@zapp/contracts';
import { describe, expect, test } from 'vitest';

import { detectProject } from '../src/detect.js';
import { analyzeGenericNode } from '../src/generic-node.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

async function allFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? await allFiles(root, path) : [relative(root, path)];
    }),
  );
  return nested.flat().sort();
}

function context(name: string, workspaceRoot = '.'): DetectionContext {
  const root = join(fixtures, name);
  return {
    workspaceRoot,
    listFiles: async () => await allFiles(root),
    readFile: async (path) => await readFile(join(root, path), 'utf8'),
  };
}

describe('generic Node project detection', () => {
  test.each([
    {
      fixture: 'npm-cra',
      manager: 'npm',
      install: 'npm ci',
      develop: 'npm run start',
      port: 3000,
      build: 'npm run build',
      unit: 'npm run test',
    },
    {
      fixture: 'pnpm-vite',
      manager: 'pnpm',
      install: 'pnpm install --frozen-lockfile',
      develop: 'pnpm run dev',
      port: 4173,
      build: 'pnpm run build',
      unit: 'pnpm run test',
    },
    {
      fixture: 'yarn-express',
      manager: 'yarn',
      install: 'yarn install --frozen-lockfile',
      develop: 'yarn run start',
      port: 4100,
      build: undefined,
      unit: 'yarn run test',
    },
    {
      fixture: 'no-scripts',
      manager: 'npm',
      install: 'npm install',
      develop: 'node index.js',
      port: 3000,
      build: undefined,
      unit: undefined,
    },
    {
      fixture: 'bun',
      manager: 'bun',
      install: 'bun install --frozen-lockfile',
      develop: 'bun run dev',
      port: 3001,
      build: 'bun run build',
      unit: 'bun run test',
    },
  ])('derives the $manager contract for $fixture', async (example) => {
    const result = await analyzeGenericNode(context(example.fixture));

    expect(result.contract).toMatchObject({
      version: 1,
      package_manager: example.manager,
      workspace_root: '.',
      install: { command: example.install },
      develop: { command: example.develop, port: example.port },
    });
    expect(result.contract.build?.command).toBe(example.build);
    expect(result.contract.test?.unit).toBe(example.unit);
    expect(result.openQuestions).toEqual([]);
  });

  test('records an explicit target-selection question for an ambiguous pnpm monorepo', async () => {
    const result = await analyzeGenericNode(context('pnpm-monorepo'));

    expect(result.contract).toMatchObject({
      package_manager: 'pnpm',
      workspace_root: '.',
      develop: { command: 'pnpm run dev', port: 3000 },
    });
    expect(result.openQuestions).toEqual([
      {
        kind: 'workspace_target',
        candidates: ['apps/api', 'apps/web'],
        prompt: 'Which workspace package is the application target?',
      },
    ]);
  });

  test('preserves a selected non-root workspace in the execution contract', async () => {
    const result = await analyzeGenericNode(context('pnpm-vite', 'apps/web'));

    expect(result.contract.workspace_root).toBe('apps/web');
  });

  test('ranks adapter detections and always includes the generic-node fallback', async () => {
    const detections = await detectProject(context('pnpm-vite'), [
      {
        id: 'fixture-vite',
        detect: () =>
          Promise.resolve({ adapterId: 'fixture-vite', confidence: 0.95, evidence: ['vite.config.ts'] }),
      },
    ]);

    expect(detections.map(({ adapterId, confidence }) => ({ adapterId, confidence }))).toEqual([
      { adapterId: 'fixture-vite', confidence: 0.95 },
      { adapterId: 'generic-node', confidence: 0.25 },
    ]);
  });
});
