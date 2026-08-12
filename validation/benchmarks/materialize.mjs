import { access, cp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBenchmarkManifest, validateBenchmarkManifest } from './validate.mjs';

async function destinationExists(destination) {
  try {
    await access(destination);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}

export async function materializeBenchmark({ benchmarkId, destination, repositoryRoot }) {
  const manifest = await loadBenchmarkManifest(repositoryRoot);
  await validateBenchmarkManifest(manifest, repositoryRoot);
  const benchmark = manifest.apps.find((candidate) => candidate.id === benchmarkId);
  if (benchmark === undefined) throw new Error(`unknown benchmark: ${benchmarkId}`);
  const target = path.resolve(destination);
  if (await destinationExists(target)) {
    throw new Error(`destination already exists: ${target}`);
  }

  const source = await realpath(path.resolve(repositoryRoot, benchmark.primarySeed));
  const targetParent = await realpath(path.dirname(target));
  const canonicalTarget = path.join(targetParent, path.basename(target));
  if (canonicalTarget.startsWith(`${source}${path.sep}`)) {
    throw new Error('destination must not be inside the benchmark seed');
  }

  await cp(source, canonicalTarget, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(
    path.join(canonicalTarget, '.zapp-benchmark.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        benchmarkId: benchmark.id,
        category: benchmark.category,
        protocol: manifest.protocol,
        sourceEvidence: benchmark.sourceEvidence,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  return benchmark;
}

async function main() {
  const [benchmarkId, destination] = process.argv.slice(2);
  if (!benchmarkId || !destination) {
    throw new Error('usage: node materialize.mjs <benchmark-id> <new-directory>');
  }
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const benchmark = await materializeBenchmark({
    benchmarkId,
    destination,
    repositoryRoot,
  });
  process.stdout.write(`${benchmark.id} materialized at ${path.resolve(destination)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
