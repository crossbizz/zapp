#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { analyzeProductionSources } from './model-provider-boundary/analyzer.mjs';
import { compareToBaseline, validateBaseline } from './model-provider-boundary/baseline.mjs';
import {
  discoverRepositoryInputs,
  shouldScanProductionFile,
} from './model-provider-boundary/discovery.mjs';
import { buildForbiddenModuleMap } from './model-provider-boundary/manifests.mjs';

const BASELINE_RELATIVE_PATH = 'config/model-provider-boundary-baseline.json';

export { compareToBaseline, shouldScanProductionFile };

export async function scanRepository(rootDirectory) {
  const { manifests, sourceFiles } = await discoverRepositoryInputs(rootDirectory);
  const forbiddenModules = await buildForbiddenModuleMap(manifests);
  return analyzeProductionSources(rootDirectory, sourceFiles, forbiddenModules);
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    baseline: path.join(process.cwd(), BASELINE_RELATIVE_PATH),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--baseline') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [inventory, baselineText] = await Promise.all([
    scanRepository(options.root),
    readFile(options.baseline, 'utf8'),
  ]);
  const acceptedBaselinePath = path.resolve(options.root, BASELINE_RELATIVE_PATH);
  const baselineFiles = validateBaseline(JSON.parse(baselineText), {
    accepted: path.resolve(options.baseline) === acceptedBaselinePath,
  });
  const violations = compareToBaseline(inventory, baselineFiles);
  if (violations.length > 0) {
    process.stderr.write(
      `Model-provider boundary failed (ADR-0005):\n${violations.map((violation) => `- ${violation}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Model-provider boundary clean: ${Object.keys(inventory).length} exact inherited paths.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Model-provider boundary error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
