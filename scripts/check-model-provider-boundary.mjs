#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { analyzeProductionSources } from './model-provider-boundary/analyzer.mjs';
import {
  compareToBaseline,
  validateAcceptedAdr,
  validateBaseline,
} from './model-provider-boundary/baseline.mjs';
import {
  discoverRepositoryInputsAtCommit,
  discoverRepositoryInputs,
  selectReachableProductionSources,
  shouldScanProductionFile,
} from './model-provider-boundary/discovery.mjs';
import { buildForbiddenModuleMap } from './model-provider-boundary/manifests.mjs';

const BASELINE_RELATIVE_PATH = 'config/model-provider-boundary-baseline.json';

export { compareToBaseline, shouldScanProductionFile };

export async function scanRepository(rootDirectory) {
  const { manifests, sourceFiles: discoveredSources } =
    await discoverRepositoryInputs(rootDirectory);
  const forbiddenModules = await buildForbiddenModuleMap(manifests);
  const sourceFiles = await selectReachableProductionSources(discoveredSources, forbiddenModules);
  return analyzeProductionSources(rootDirectory, sourceFiles, forbiddenModules);
}

export async function scanRepositoryAtCommit(rootDirectory, commit) {
  const { manifests, sourceFiles: discoveredSources } = discoverRepositoryInputsAtCommit(
    rootDirectory,
    commit,
  );
  const forbiddenModules = await buildForbiddenModuleMap(manifests);
  const sourceFiles = await selectReachableProductionSources(discoveredSources, forbiddenModules);
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
  const baselineText = await readFile(options.baseline, 'utf8');
  const acceptedBaselinePath = path.resolve(options.root, BASELINE_RELATIVE_PATH);
  const accepted = path.resolve(options.baseline) === acceptedBaselinePath;
  const baseline = JSON.parse(baselineText);
  const baselineFiles = validateBaseline(baseline, { accepted });

  if (accepted) {
    const adrText = await readFile(path.resolve(options.root, baseline.adr), 'utf8');
    validateAcceptedAdr(adrText, baseline);
    const resolvedCommit = execFileSync(
      'git',
      ['-C', options.root, 'rev-parse', `${baseline.baselineCommit}^{commit}`],
      { encoding: 'utf8' },
    ).trim();
    if (resolvedCommit !== baseline.baselineCommit) {
      throw new Error(
        `baseline commit resolves to ${resolvedCommit}, expected ${baseline.baselineCommit}`,
      );
    }
    const resolvedTree = execFileSync(
      'git',
      ['-C', options.root, 'show', '-s', '--format=%T', baseline.baselineCommit],
      { encoding: 'utf8' },
    ).trim();
    if (resolvedTree !== baseline.baselineTree) {
      throw new Error(
        `baseline tree resolves to ${resolvedTree}, expected ${baseline.baselineTree}`,
      );
    }
    const anchorInventory = await scanRepositoryAtCommit(options.root, baseline.baselineCommit);
    const anchorViolations = compareToBaseline(anchorInventory, baselineFiles);
    if (anchorViolations.length > 0) {
      throw new Error(
        `accepted baseline is not the exact anchor inventory:\n${anchorViolations.join('\n')}`,
      );
    }
  }

  const inventory = await scanRepository(options.root);
  const violations = compareToBaseline(inventory, baselineFiles);
  if (violations.length > 0) {
    process.stderr.write(
      `Model-provider boundary failed (ADR-0005):\n${violations.map((violation) => `- ${violation}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Model-provider boundary clean: ${Object.keys(inventory).length} exact inherited paths${
      accepted ? ` anchored to ${baseline.baselineCommit}` : ''
    }.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Model-provider boundary error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
