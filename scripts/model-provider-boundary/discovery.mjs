import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { resolvePackageImportTargets } from './manifests.mjs';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_SOURCE_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NEVER_READ_PREFIXES = [
  'apps/desktop/src/pro/',
  'scripts/fixtures/model-provider-boundary/',
  'services/model-gateway/',
];
const TEST_ONLY_ROOT_PREFIXES = [
  'apps/desktop/e2e-tests/',
  'apps/desktop/testing/fake-llm-server/',
];
const EXACT_TEST_ONLY_ROOTS = new Set([
  'apps/desktop/src/testing/chat_flow_harness.ts',
  'apps/desktop/src/testing/electron_mock.ts',
  'apps/desktop/src/testing/handler_test_harness.ts',
  'apps/desktop/src/testing/hybrid.setup.ts',
  'apps/desktop/src/testing/hybrid_chat_harness.tsx',
  'apps/desktop/src/testing/renderer_ipc_bridge.ts',
  'apps/desktop/src/testing/server_dump.ts',
  'apps/desktop/src/testing/test_db.ts',
]);
const WALK_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function hasPrefix(relativePath, prefixes) {
  return prefixes.some(
    (prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix),
  );
}

export function shouldScanProductionFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return SOURCE_EXTENSION.test(normalizedPath) && !hasPrefix(normalizedPath, NEVER_READ_PREFIXES);
}

function isProductionRoot(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return (
    !TEST_SOURCE_FILE.test(normalizedPath) &&
    !normalizedPath.split('/').includes('__tests__') &&
    !EXACT_TEST_ONLY_ROOTS.has(normalizedPath) &&
    !hasPrefix(normalizedPath, TEST_ONLY_ROOT_PREFIXES)
  );
}

function shouldReadManifest(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return (
    path.posix.basename(normalizedPath) === 'package.json' &&
    !hasPrefix(
      normalizedPath,
      NEVER_READ_PREFIXES.filter((prefix) => prefix !== 'services/model-gateway/'),
    )
  );
}

async function resolveInRepoFile(rootDirectory, relativePath, mode) {
  const absolutePath = path.resolve(rootDirectory, relativePath);
  if (mode !== '120000') return absolutePath;
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
      if (separator < 0) throw new Error(`unexpected git ls-files entry: ${entry}`);
      const metadata = entry.slice(0, separator).split(' ');
      return { mode: metadata[0], relativePath: toPosixPath(entry.slice(separator + 1)) };
    });
}

function parseTreeEntries(output) {
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error(`unexpected git ls-tree entry: ${entry}`);
      const [mode, type, object] = entry.slice(0, separator).split(' ');
      return { mode, object, type, relativePath: toPosixPath(entry.slice(separator + 1)) };
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
  if ((await realpath(gitRoot)) !== (await realpath(rootDirectory))) return undefined;
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
  return { manifests, mode: 'tracked', sourceFiles };
}

function readGitBlob(rootDirectory, object) {
  return execFileSync('git', ['-C', rootDirectory, 'cat-file', 'blob', object], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function historicalSymlinkTarget(
  rootDirectory,
  entry,
  entriesByPath,
  archivePaths,
  seen = new Set(),
) {
  if (entry.mode !== '120000') return;
  if (seen.has(entry.relativePath)) {
    throw new Error(`tracked source symlink cycle at anchor: ${entry.relativePath}`);
  }
  const target = readGitBlob(rootDirectory, entry.object);
  if (path.posix.isAbsolute(target)) {
    throw new Error(`tracked source symlink escapes repository at anchor: ${entry.relativePath}`);
  }
  const targetPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(entry.relativePath), target),
  );
  if (targetPath === '..' || targetPath.startsWith('../')) {
    throw new Error(`tracked source symlink escapes repository at anchor: ${entry.relativePath}`);
  }
  if (targetPath === 'apps/desktop/src/pro' || targetPath.startsWith('apps/desktop/src/pro/')) {
    throw new Error(
      `tracked source symlink targets the excluded Pro tree at anchor: ${entry.relativePath}`,
    );
  }
  const targetEntry = entriesByPath.get(targetPath);
  if (!targetEntry || targetEntry.type !== 'blob') {
    throw new Error(`tracked source symlink is not a file at anchor: ${entry.relativePath}`);
  }
  archivePaths.add(targetPath);
  historicalSymlinkTarget(
    rootDirectory,
    targetEntry,
    entriesByPath,
    archivePaths,
    new Set([...seen, entry.relativePath]),
  );
}

export function discoverRepositoryInputsAtCommit(rootDirectory, commit) {
  const output = execFileSync(
    'git',
    ['-C', rootDirectory, 'ls-tree', '-rz', '--full-tree', commit],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  const entries = parseTreeEntries(output);
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const selectedEntries = entries.filter(
    (entry) =>
      entry.type === 'blob' &&
      (shouldScanProductionFile(entry.relativePath) || shouldReadManifest(entry.relativePath)),
  );
  const archivePaths = new Set(selectedEntries.map((entry) => entry.relativePath));
  for (const entry of selectedEntries) {
    historicalSymlinkTarget(rootDirectory, entry, entriesByPath, archivePaths);
  }

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'model-provider-anchor-'));
  try {
    const archive = execFileSync(
      'git',
      ['-C', rootDirectory, 'archive', '--format=tar', commit, '--', ...archivePaths],
      { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 },
    );
    execFileSync('tar', ['-xf', '-', '-C', temporaryDirectory], {
      input: archive,
      maxBuffer: 100 * 1024 * 1024,
    });
    const sourceFiles = [];
    const manifests = [];
    for (const entry of selectedEntries) {
      const absolutePath = path.join(temporaryDirectory, entry.relativePath);
      if (entry.mode === '120000' && !lstatSync(absolutePath).isSymbolicLink()) {
        throw new Error(
          `tracked source symlink was not preserved at anchor: ${entry.relativePath}`,
        );
      }
      const discoveredEntry = {
        relativePath: entry.relativePath,
        text: readFileSync(absolutePath, 'utf8'),
      };
      if (shouldScanProductionFile(entry.relativePath)) sourceFiles.push(discoveredEntry);
      else manifests.push(discoveredEntry);
    }
    return { manifests, mode: 'commit', sourceFiles };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
  return { manifests, mode: 'fixture', sourceFiles };
}

async function entryText(entry) {
  return entry.text ?? readFile(entry.absolutePath, 'utf8');
}

function staticStrings(expression, constants, seen = new Set()) {
  if (ts.isParenthesizedExpression(expression))
    return staticStrings(expression.expression, constants, seen);
  if (ts.isStringLiteralLike(expression)) return new Set([expression.text]);
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return new Set([expression.text]);
  if (ts.isTemplateExpression(expression)) {
    let values = new Set([expression.head.text]);
    for (const span of expression.templateSpans) {
      const parts = staticStrings(span.expression, constants, seen);
      if (!parts) return undefined;
      values = new Set(
        [...values].flatMap((prefix) =>
          [...parts].map((part) => `${prefix}${part}${span.literal.text}`),
        ),
      );
    }
    return values;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStrings(expression.left, constants, seen);
    const right = staticStrings(expression.right, constants, seen);
    return left && right
      ? new Set([...left].flatMap((prefix) => [...right].map((suffix) => prefix + suffix)))
      : undefined;
  }
  if (ts.isConditionalExpression(expression)) {
    const left = staticStrings(expression.whenTrue, constants, seen);
    const right = staticStrings(expression.whenFalse, constants, seen);
    return left && right ? new Set([...left, ...right]) : undefined;
  }
  if (ts.isIdentifier(expression) && constants.has(expression.text) && !seen.has(expression.text)) {
    return staticStrings(
      constants.get(expression.text),
      constants,
      new Set([...seen, expression.text]),
    );
  }
  return undefined;
}

function localCandidates(sourcePath, moduleName, policy) {
  const bases = [];
  if (moduleName.startsWith('.')) {
    bases.push(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), moduleName)));
  } else if (moduleName.startsWith('@/')) {
    bases.push(path.posix.join('apps/desktop/src', moduleName.slice(2)));
  } else if (moduleName.startsWith('#')) {
    for (const resolved of resolvePackageImportTargets(moduleName, policy, sourcePath)) {
      if (resolved.target.startsWith('./')) {
        bases.push(
          path.posix.normalize(path.posix.join(resolved.packageDirectory, resolved.target)),
        );
      }
    }
  }
  return bases.flatMap((base) => {
    const extension = path.posix.extname(base);
    if (SOURCE_EXTENSIONS.includes(extension)) {
      const candidates = [base];
      if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
        const stem = base.slice(0, -extension.length);
        candidates.push(...SOURCE_EXTENSIONS.map((candidate) => `${stem}${candidate}`));
      }
      return candidates;
    }
    return [
      ...SOURCE_EXTENSIONS.map((candidate) => `${base}${candidate}`),
      ...SOURCE_EXTENSIONS.map((candidate) => path.posix.join(base, `index${candidate}`)),
    ];
  });
}

function dependenciesForSource(sourcePath, text, sourcePaths, policy) {
  const sourceFile = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  const constants = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(ts.getCombinedNodeFlags(statement.declarationList) & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const requestedModules = new Set();
  function addExpression(expression) {
    const targets = staticStrings(expression, constants);
    if (targets) for (const target of targets) requestedModules.add(target);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const importClause = node.importClause;
      const onlyNamedTypes =
        importClause?.namedBindings &&
        ts.isNamedImports(importClause.namedBindings) &&
        !importClause.name &&
        importClause.namedBindings.elements.every((specifier) => specifier.isTypeOnly);
      if (!importClause?.isTypeOnly && !onlyNamedTypes) addExpression(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const onlyNamedTypes =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.every((specifier) => specifier.isTypeOnly);
      if (!node.isTypeOnly && !onlyNamedTypes) addExpression(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      addExpression(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      // Any statically local module-looking call target is conservatively an edge.
      // This covers require aliases and createRequire aliases without trusting names.
      addExpression(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const dependencies = new Set();
  for (const requestedModule of requestedModules) {
    const resolved = localCandidates(sourcePath, requestedModule, policy).find((candidate) =>
      sourcePaths.has(candidate),
    );
    if (resolved) dependencies.add(resolved);
  }
  return dependencies;
}

export async function selectReachableProductionSources(sourceEntries, policy) {
  const entries = await Promise.all(
    sourceEntries.map(async (entry) => ({ ...entry, text: await entryText(entry) })),
  );
  const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const sourcePaths = new Set(byPath.keys());
  const dependencies = new Map(
    entries.map((entry) => [
      entry.relativePath,
      dependenciesForSource(entry.relativePath, entry.text, sourcePaths, policy),
    ]),
  );
  const reachable = new Set(
    entries
      .filter((entry) => isProductionRoot(entry.relativePath))
      .map((entry) => entry.relativePath),
  );
  const pending = [...reachable];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const dependency of dependencies.get(current) ?? []) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return [...reachable].sort().map((relativePath) => byPath.get(relativePath));
}

function sortInputs(inputs) {
  inputs.manifests.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  inputs.sourceFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return inputs;
}

export async function discoverRepositoryInputs(rootDirectory) {
  return sortInputs(
    (await discoverTrackedInputs(rootDirectory)) ?? (await discoverFixtureInputs(rootDirectory)),
  );
}
