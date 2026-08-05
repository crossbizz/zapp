import { execFileSync } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_SOURCE_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const EXACT_EXCLUDED_PREFIXES = [
  'apps/desktop/e2e-tests/',
  'apps/desktop/src/__tests__/',
  'apps/desktop/src/pro/',
  'apps/desktop/testing/fake-llm-server/',
  'scripts/fixtures/model-provider-boundary/',
  'services/model-gateway/',
];
const EXACT_MANIFEST_EXCLUDED_PREFIXES = EXACT_EXCLUDED_PREFIXES.filter(
  (prefix) => prefix !== 'services/model-gateway/',
);
const WALK_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function hasExactExcludedPrefix(relativePath) {
  return EXACT_EXCLUDED_PREFIXES.some(
    (prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix),
  );
}

function hasExactManifestExcludedPrefix(relativePath) {
  return EXACT_MANIFEST_EXCLUDED_PREFIXES.some(
    (prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix),
  );
}

export function shouldScanProductionFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return (
    SOURCE_EXTENSION.test(normalizedPath) &&
    !TEST_SOURCE_FILE.test(normalizedPath) &&
    !hasExactExcludedPrefix(normalizedPath)
  );
}

function shouldReadManifest(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return (
    path.posix.basename(normalizedPath) === 'package.json' &&
    !hasExactManifestExcludedPrefix(normalizedPath)
  );
}

async function resolveInRepoFile(rootDirectory, relativePath, mode) {
  const absolutePath = path.resolve(rootDirectory, relativePath);
  if (mode !== '120000') {
    return absolutePath;
  }
  const resolvedPath = await realpath(absolutePath);
  const relativeTarget = path.relative(await realpath(rootDirectory), resolvedPath);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error(`tracked source symlink escapes repository: ${relativePath}`);
  }
  const normalizedTarget = toPosixPath(relativeTarget);
  if (
    normalizedTarget === 'apps/desktop/src/pro' ||
    normalizedTarget.startsWith('apps/desktop/src/pro/')
  ) {
    throw new Error(`tracked source symlink targets the excluded Pro tree: ${relativePath}`);
  }
  const targetStats = await lstat(resolvedPath);
  if (!targetStats.isFile()) {
    throw new Error(`tracked source symlink is not a file: ${relativePath}`);
  }
  return resolvedPath;
}

function parseTrackedEntries(output) {
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t');
      if (separator < 0) {
        throw new Error(`unexpected git ls-files entry: ${entry}`);
      }
      const metadata = entry.slice(0, separator).split(' ');
      return { mode: metadata[0], relativePath: toPosixPath(entry.slice(separator + 1)) };
    });
}

async function discoverTrackedInputs(rootDirectory) {
  let gitRoot;
  try {
    gitRoot = execFileSync('git', ['-C', rootDirectory, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
  if ((await realpath(gitRoot)) !== (await realpath(rootDirectory))) {
    return undefined;
  }
  const output = execFileSync('git', ['-C', rootDirectory, 'ls-files', '--stage', '-z'], {
    encoding: 'utf8',
  });
  const sourceFiles = [];
  const manifests = [];
  for (const entry of parseTrackedEntries(output)) {
    if (shouldScanProductionFile(entry.relativePath)) {
      sourceFiles.push({
        absolutePath: await resolveInRepoFile(rootDirectory, entry.relativePath, entry.mode),
        relativePath: entry.relativePath,
      });
    } else if (shouldReadManifest(entry.relativePath)) {
      manifests.push({
        absolutePath: await resolveInRepoFile(rootDirectory, entry.relativePath, entry.mode),
        relativePath: entry.relativePath,
      });
    }
  }
  return {
    manifests: manifests.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    mode: 'tracked',
    sourceFiles: sourceFiles.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
  };
}

async function discoverFixtureInputs(rootDirectory) {
  const sourceFiles = [];
  const manifests = [];
  async function visit(relativeDirectory) {
    const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
      if (entry.isDirectory()) {
        if (
          !WALK_EXCLUDED_DIRECTORIES.has(entry.name) &&
          !relativePath
            .split('/')
            .some((segment, index, segments) => segment === 'src' && segments[index + 1] === 'pro')
        ) {
          await visit(relativePath);
        }
      } else if (entry.isFile()) {
        if (shouldScanProductionFile(relativePath)) {
          sourceFiles.push({ absolutePath: path.join(rootDirectory, relativePath), relativePath });
        } else if (shouldReadManifest(relativePath)) {
          manifests.push({ absolutePath: path.join(rootDirectory, relativePath), relativePath });
        }
      }
    }
  }
  await visit('');
  return {
    manifests: manifests.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    mode: 'fixture',
    sourceFiles: sourceFiles.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
  };
}

export async function discoverRepositoryInputs(rootDirectory) {
  return (
    (await discoverTrackedInputs(rootDirectory)) ?? (await discoverFixtureInputs(rootDirectory))
  );
}
