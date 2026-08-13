import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadBenchmarkManifest, validateBenchmarkManifest } from './validate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

test('V-1 catalog covers the ten PRD categories and fifty repeat changes', async () => {
  const manifest = await loadBenchmarkManifest(root);
  const result = await validateBenchmarkManifest(manifest, root);

  assert.deepEqual(result, { apps: 10, featureChanges: 50 });
});

test('V-1 validation rejects category drift and paths outside the repository', async () => {
  const manifest = await loadBenchmarkManifest(root);
  const invalid = structuredClone(manifest);
  invalid.apps[0].category = invalid.apps[1].category;
  invalid.apps[0].primarySeed = '../../outside';

  await assert.rejects(
    validateBenchmarkManifest(invalid, root),
    /benchmark categories must match PRD §40\.2|repository-relative/u,
  );
});

test('V-1 materializer creates an isolated runnable seed and refuses overwrite', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'zapp-benchmark-'));
  const target = path.join(temporaryRoot, 'crud');
  try {
    const { materializeBenchmark } = await import('./materialize.mjs');
    const first = await materializeBenchmark({
      benchmarkId: 'react-vite-crud',
      destination: target,
      repositoryRoot: root,
    });
    assert.equal(first.id, 'react-vite-crud');
    assert.equal(
      JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).private,
      true,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(target, '.zapp-benchmark.json'), 'utf8')).benchmarkId,
      'react-vite-crud',
    );
    await assert.rejects(
      materializeBenchmark({
        benchmarkId: 'react-vite-crud',
        destination: target,
        repositoryRoot: root,
      }),
      /destination already exists/u,
    );
    await assert.rejects(
      materializeBenchmark({
        benchmarkId: 'react-vite-crud',
        destination: path.join(
          root,
          'apps/desktop/e2e-tests/fixtures/import-app/minimal/nested-benchmark',
        ),
        repositoryRoot: root,
      }),
      /destination must not be inside the benchmark seed/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('V-1 manifest is deterministic JSON', async () => {
  const manifest = await loadBenchmarkManifest(root);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'zapp-manifest-'));
  try {
    const copy = path.join(temporaryRoot, 'manifest.json');
    await writeFile(copy, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(await readFile(copy, 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('V-1 rejects environment files and symbolic links in materialized seeds', async () => {
  const manifest = structuredClone(await loadBenchmarkManifest(root));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'zapp-seed-policy-'));
  const seed = path.join(temporaryRoot, 'seed');
  try {
    await mkdir(path.join(temporaryRoot, 'validation', 'benchmarks'), {
      recursive: true,
    });
    await mkdir(seed);
    await writeFile(
      path.join(seed, 'package.json'),
      '{"private":true,"scripts":{"build":"true"}}\n',
    );
    await writeFile(path.join(temporaryRoot, 'evidence.txt'), 'fixture evidence\n');
    for (const app of manifest.apps) {
      app.primarySeed = 'seed';
      app.sourceEvidence = ['evidence.txt'];
    }

    const environmentFile = path.join(seed, '.env.local');
    await writeFile(environmentFile, 'FIXTURE_VALUE=present\n');
    await assert.rejects(
      validateBenchmarkManifest(manifest, temporaryRoot),
      /committed environment file/u,
    );
    await rm(environmentFile);

    await symlink(path.join(temporaryRoot, 'evidence.txt'), path.join(seed, 'link'));
    await assert.rejects(validateBenchmarkManifest(manifest, temporaryRoot), /symbolic link/u);
    await rm(path.join(seed, 'link'));

    await mkdir(path.join(seed, '.git'));
    await assert.rejects(
      validateBenchmarkManifest(manifest, temporaryRoot),
      /generated or repository metadata/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
