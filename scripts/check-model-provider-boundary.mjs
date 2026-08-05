#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE =
  /(?:^|\/)(?:__tests__|e2e-tests|fixtures|test|testing|tests)(?:\/|$)|\.(?:e2e|integration\.test|spec|test)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORY = new Set([
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const COMPLETION_APIS = new Set([
  'embed',
  'embedMany',
  'experimental_generateImage',
  'experimental_transcribe',
  'generateImage',
  'generateObject',
  'generateText',
  'rerank',
  'streamObject',
  'streamText',
  'transcribe',
]);
const NON_PROVIDER_AI_SDK_PACKAGES = new Set([
  '@ai-sdk/mcp',
  '@ai-sdk/provider',
  '@ai-sdk/provider-utils',
]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function shouldScanProductionFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  if (!SOURCE_EXTENSION.test(normalizedPath) || TEST_FILE.test(normalizedPath)) {
    return false;
  }
  if (
    normalizedPath === 'services/model-gateway' ||
    normalizedPath.startsWith('services/model-gateway/')
  ) {
    return false;
  }
  const segments = normalizedPath.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === 'src' && segments[index + 1] === 'pro') {
      return false;
    }
  }
  return ['apps', 'packages', 'sandbox', 'services'].includes(segments[0]);
}

function shouldEnterDirectory(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  const segments = normalizedPath.split('/').filter(Boolean);
  const directoryName = segments.at(-1);
  if (SKIPPED_DIRECTORY.has(directoryName)) {
    return false;
  }
  if (
    normalizedPath === 'services/model-gateway' ||
    normalizedPath.startsWith('services/model-gateway/')
  ) {
    return false;
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === 'src' && segments[index + 1] === 'pro') {
      return false;
    }
  }
  return !TEST_FILE.test(`${normalizedPath}/`);
}

async function findProductionSourceFiles(rootDirectory) {
  const files = [];

  async function visit(relativeDirectory) {
    const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
      if (entry.isDirectory()) {
        if (shouldEnterDirectory(relativePath)) {
          await visit(relativePath);
        }
      } else if (entry.isFile() && shouldScanProductionFile(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  for (const sourceRoot of ['apps', 'packages', 'sandbox', 'services']) {
    try {
      await visit(sourceRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return files.sort();
}

function isProviderPackage(moduleName) {
  if (!moduleName.startsWith('@ai-sdk/')) {
    return false;
  }
  const packageName = moduleName.split('/').slice(0, 2).join('/');
  return !NON_PROVIDER_AI_SDK_PACKAGES.has(packageName);
}

function isInsideImport(identifier) {
  let node = identifier.parent;
  while (node) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      return true;
    }
    if (ts.isSourceFile(node)) {
      return false;
    }
    node = node.parent;
  }
  return false;
}

function isTypeReference(identifier) {
  let node = identifier;
  while (node.parent && !ts.isSourceFile(node.parent)) {
    node = node.parent;
    if (ts.isTypeNode(node)) {
      return true;
    }
    if (ts.isStatement(node) || ts.isExpression(node)) {
      return false;
    }
  }
  return false;
}

function hasRuntimeReference(sourceFile, localName) {
  let foundReference = false;
  let foundRuntimeReference = false;

  function visit(node) {
    if (ts.isIdentifier(node) && node.text === localName && !isInsideImport(node)) {
      foundReference = true;
      if (!isTypeReference(node)) {
        foundRuntimeReference = true;
      }
    }
    if (!foundRuntimeReference) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  return !foundReference || foundRuntimeReference;
}

function isRuntimeReferenceIdentifier(identifier) {
  if (isInsideImport(identifier) || isTypeReference(identifier)) {
    return false;
  }
  const parent = identifier.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === identifier) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === identifier) ||
    (ts.isEnumDeclaration(parent) && parent.name === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    (ts.isBreakOrContinueStatement(parent) && parent.label === identifier)
  ) {
    return false;
  }
  return true;
}

function countRuntimeReferences(sourceFile, localName) {
  let count = 0;
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === localName && isRuntimeReferenceIdentifier(node)) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function getModuleName(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function getCalleePath(expression) {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  if (ts.isIdentifier(node)) {
    return { root: node.text, members: [] };
  }
  if (ts.isPropertyAccessExpression(node)) {
    const parentPath = getCalleePath(node.expression);
    return parentPath
      ? { root: parentPath.root, members: [...parentPath.members, node.name.text] }
      : undefined;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    const parentPath = getCalleePath(node.expression);
    return parentPath
      ? {
          root: parentPath.root,
          members: [...parentPath.members, node.argumentExpression.text],
        }
      : undefined;
  }
  return undefined;
}

function collectFileInventory(relativePath, sourceText) {
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const providerImports = {};
  const providerCalls = {};
  const providerUses = {};
  const callableBindings = new Map();
  const namespaceBindings = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleName = getModuleName(statement.moduleSpecifier);
      if (!moduleName || !statement.importClause?.isTypeOnly) {
        if (!moduleName) {
          continue;
        }
        const providerModule = isProviderPackage(moduleName);
        const namedBindings = statement.importClause?.namedBindings;
        const defaultBinding = statement.importClause?.name;

        if (!statement.importClause && providerModule) {
          increment(providerImports, `import:${moduleName}#<side-effect>`);
        }
        if (
          defaultBinding &&
          hasRuntimeReference(sourceFile, defaultBinding.text) &&
          providerModule
        ) {
          increment(providerImports, `import:${moduleName}#default`);
          callableBindings.set(defaultBinding.text, {
            moduleName,
            importedName: 'default',
            completion: false,
          });
        }
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          if (providerModule) {
            increment(providerImports, `import:${moduleName}#*`);
            namespaceBindings.set(namedBindings.name.text, {
              moduleName,
              completion: false,
            });
          } else if (moduleName === 'ai') {
            namespaceBindings.set(namedBindings.name.text, {
              moduleName,
              completion: true,
            });
          }
        }
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const specifier of namedBindings.elements) {
            if (specifier.isTypeOnly) {
              continue;
            }
            const localName = specifier.name.text;
            const importedName = specifier.propertyName?.text ?? localName;
            if (!hasRuntimeReference(sourceFile, localName)) {
              continue;
            }
            const completion = moduleName === 'ai' && COMPLETION_APIS.has(importedName);
            if (!providerModule && !completion) {
              continue;
            }
            increment(providerImports, `import:${moduleName}#${importedName}`);
            callableBindings.set(localName, {
              moduleName,
              importedName,
              completion,
            });
          }
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier
    ) {
      const moduleName = getModuleName(statement.moduleSpecifier);
      if (moduleName && isProviderPackage(moduleName)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const specifier of statement.exportClause.elements) {
            if (!specifier.isTypeOnly) {
              increment(
                providerImports,
                `import:${moduleName}#${specifier.propertyName?.text ?? specifier.name.text}`,
              );
            }
          }
        } else {
          increment(providerImports, `import:${moduleName}#*`);
        }
      }
    }
  }

  const importedCallableBindings = new Map(callableBindings);

  function resolveCallableBinding(calleePath) {
    const directBinding = callableBindings.get(calleePath.root);
    if (directBinding) {
      const memberSuffix = calleePath.members.length ? `.${calleePath.members.join('.')}` : '';
      return {
        ...directBinding,
        importedName: `${directBinding.importedName}${memberSuffix}`,
      };
    }
    const namespace = namespaceBindings.get(calleePath.root);
    const firstMember = calleePath.members[0];
    if (namespace && firstMember && (!namespace.completion || COMPLETION_APIS.has(firstMember))) {
      return {
        moduleName: namespace.moduleName,
        importedName: calleePath.members.join('.'),
        completion: namespace.completion,
      };
    }
    return undefined;
  }

  let foundAlias = true;
  while (foundAlias) {
    foundAlias = false;
    function visitAliases(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !callableBindings.has(node.name.text)
      ) {
        const initializerPath = getCalleePath(node.initializer);
        const binding = initializerPath ? resolveCallableBinding(initializerPath) : undefined;
        if (binding) {
          callableBindings.set(node.name.text, binding);
          if (binding.completion) {
            providerImports[`import:${binding.moduleName}#${binding.importedName}`] = 1;
          }
          foundAlias = true;
        }
      }
      ts.forEachChild(node, visitAliases);
    }
    visitAliases(sourceFile);
  }

  for (const [localName, binding] of importedCallableBindings) {
    const referenceCount = countRuntimeReferences(sourceFile, localName);
    if (referenceCount > 0) {
      providerUses[`use:${binding.moduleName}#${binding.importedName}`] = referenceCount;
    }
  }
  for (const [localName, binding] of namespaceBindings) {
    const referenceCount = countRuntimeReferences(sourceFile, localName);
    if (referenceCount > 0) {
      providerUses[`use:${binding.moduleName}#*`] = referenceCount;
    }
  }

  function visitCalls(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const calleePath = getCalleePath(node.expression);
      if (calleePath) {
        const binding = resolveCallableBinding(calleePath);
        if (binding) {
          increment(providerCalls, `call:${binding.moduleName}#${binding.importedName}`);
          if (binding.completion) {
            providerImports[`import:${binding.moduleName}#${binding.importedName}`] = 1;
          }
        }
      }

      const moduleName =
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          ? getModuleName(node.arguments[0])
          : undefined;
      if (moduleName && (moduleName === 'ai' || isProviderPackage(moduleName))) {
        increment(providerImports, `import:${moduleName}#<dynamic>`);
      }
    }
    ts.forEachChild(node, visitCalls);
  }

  visitCalls(sourceFile);
  return { providerCalls, providerImports, providerUses };
}

export async function scanRepository(rootDirectory) {
  const inventory = {};
  const files = await findProductionSourceFiles(rootDirectory);
  for (const relativePath of files) {
    const sourceText = await readFile(path.join(rootDirectory, relativePath), 'utf8');
    const fileInventory = collectFileInventory(relativePath, sourceText);
    if (
      Object.keys(fileInventory.providerCalls).length > 0 ||
      Object.keys(fileInventory.providerImports).length > 0 ||
      Object.keys(fileInventory.providerUses).length > 0
    ) {
      inventory[relativePath] = fileInventory;
    }
  }
  return inventory;
}

function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || !baseline.files) {
    throw new Error('baseline must contain a files object');
  }
  return baseline.files;
}

export function compareToBaseline(inventory, baselineFiles) {
  const violations = [];
  for (const [relativePath, actual] of Object.entries(inventory)) {
    const allowed = baselineFiles[relativePath];
    if (!allowed) {
      violations.push(`new-provider path: ${relativePath}`);
      continue;
    }
    for (const category of ['providerImports', 'providerCalls', 'providerUses']) {
      for (const [key, count] of Object.entries(actual[category])) {
        const allowedCount = allowed[category]?.[key] ?? 0;
        if (count > allowedCount) {
          const violationKind =
            category === 'providerCalls'
              ? 'provider-call growth'
              : category === 'providerUses'
                ? 'provider-use growth'
                : 'provider-import growth';
          violations.push(
            `${violationKind}: ${relativePath} ${key} allowed ${allowedCount}, found ${count}`,
          );
        }
      }
    }
  }
  return violations;
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    baseline: path.join(process.cwd(), 'config/model-provider-boundary-baseline.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--baseline') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
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
  const baselineFiles = validateBaseline(JSON.parse(baselineText));
  const violations = compareToBaseline(inventory, baselineFiles);
  if (violations.length > 0) {
    process.stderr.write(
      `Model-provider boundary failed (ADR-0005):\n${violations.map((violation) => `- ${violation}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Model-provider boundary clean: ${Object.keys(inventory).length} inherited desktop paths, no growth.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Model-provider boundary error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
