import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

import { resolveForbiddenModule, resolvePackageImportTargets } from './manifests.mjs';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TRUSTED_TYPESCRIPT_RESOLVER = 'apps/desktop/shared/node_module_resolution.ts';
const TRUSTED_PLAYWRIGHT_LOADER = 'apps/desktop/src/ipc/utils/playwright_bootstrap.ts';
const TRUSTED_TYPESCRIPT_LOADER_PATHS = new Set([
  'apps/desktop/workers/code_explorer/code_explorer_worker.ts',
  'apps/desktop/workers/supabase_dependency_analysis/supabase_dependency_analysis_worker.ts',
]);

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolvedExtension(fileName) {
  if (fileName.endsWith('.tsx')) return ts.Extension.Tsx;
  if (fileName.endsWith('.mts')) return ts.Extension.Mts;
  if (fileName.endsWith('.cts')) return ts.Extension.Cts;
  if (fileName.endsWith('.jsx')) return ts.Extension.Jsx;
  if (fileName.endsWith('.mjs')) return ts.Extension.Mjs;
  if (fileName.endsWith('.cjs')) return ts.Extension.Cjs;
  if (fileName.endsWith('.js')) return ts.Extension.Js;
  return ts.Extension.Ts;
}

function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function localModuleCandidates(basePath) {
  const extension = path.extname(basePath);
  const candidates = [];
  if (SOURCE_EXTENSIONS.includes(extension)) {
    candidates.push(basePath);
    const withoutExtension = basePath.slice(0, -extension.length);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
      candidates.push(...SOURCE_EXTENSIONS.map((candidate) => `${withoutExtension}${candidate}`));
    }
  } else {
    candidates.push(...SOURCE_EXTENSIONS.map((candidate) => `${basePath}${candidate}`));
    candidates.push(
      ...SOURCE_EXTENSIONS.map((candidate) => path.join(basePath, `index${candidate}`)),
    );
  }
  return candidates;
}

function createProgram(rootDirectory, sources) {
  const sourceByProgramPath = new Map(
    sources.map((source) => [path.resolve(rootDirectory, source.relativePath), source]),
  );
  const options = {
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    sourceByProgramPath.has(path.resolve(fileName)) || originalFileExists(fileName);
  host.readFile = (fileName) =>
    sourceByProgramPath.get(path.resolve(fileName))?.text ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const source = sourceByProgramPath.get(path.resolve(fileName));
    if (source) {
      return ts.createSourceFile(
        fileName,
        source.text,
        languageVersion,
        true,
        scriptKind(fileName),
      );
    }
    const text = originalReadFile(fileName);
    if (text === undefined) {
      onError?.(`Cannot read ${fileName}`);
      return undefined;
    }
    return ts.createSourceFile(fileName, text, languageVersion, true);
  };
  function resolveModule(moduleName, containingFile) {
    let basePath;
    if (moduleName.startsWith('.')) {
      basePath = path.resolve(path.dirname(containingFile), moduleName);
    } else if (moduleName.startsWith('@/')) {
      basePath = path.resolve(rootDirectory, 'apps/desktop/src', moduleName.slice(2));
    } else {
      return undefined;
    }
    const resolvedFileName = localModuleCandidates(basePath).find((candidate) =>
      sourceByProgramPath.has(path.resolve(candidate)),
    );
    return resolvedFileName
      ? {
          extension: resolvedExtension(resolvedFileName),
          isExternalLibraryImport: false,
          resolvedFileName,
        }
      : undefined;
  }
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => resolveModule(moduleName, containingFile));
  host.resolveModuleNameLiterals = (moduleLiterals, containingFile) =>
    moduleLiterals.map((literal) => ({
      resolvedModule: resolveModule(literal.text, containingFile),
    }));

  return {
    program: ts.createProgram({
      host,
      options,
      rootNames: [...sourceByProgramPath.keys()],
    }),
    sourceByProgramPath,
  };
}

function moduleName(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function origin(moduleSpecifier, exportedName) {
  return `${moduleSpecifier}#${exportedName}`;
}

function appendMember(origins, member) {
  return new Set(
    [...origins].map((value) => {
      const separator = value.lastIndexOf('#');
      const moduleSpecifier = value.slice(0, separator);
      const exportedName = value.slice(separator + 1);
      return origin(
        moduleSpecifier,
        // Resolve namespace/dynamic imports to the selected export, but keep
        // provenance from an already-selected export stable through object and
        // return-value properties. The gate inventories growth by provider
        // export; property spelling is not an escape hatch or a noisy baseline.
        exportedName === '*' ? member : exportedName,
      );
    }),
  );
}

function union(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

function symbolAt(checker, node) {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    return undefined;
  }
}

function aliasedSymbol(checker, symbol) {
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) {
    return undefined;
  }
  try {
    const target = checker.getAliasedSymbol(symbol);
    return target === symbol ? undefined : target;
  } catch {
    return undefined;
  }
}

function isClassExtendsExpression(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isExpressionWithTypeArguments(parent)) {
      const heritage = parent.parent;
      return (
        (current === parent.expression || current.pos >= parent.expression.pos) &&
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent))
      );
    }
    if (ts.isStatement(parent) || ts.isExpression(parent)) {
      return false;
    }
    current = parent;
  }
  return false;
}

function isInsideImportOrExport(identifier) {
  let current = identifier.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isTypePosition(identifier) {
  if (isClassExtendsExpression(identifier)) {
    return false;
  }
  let current = identifier;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    current = current.parent;
    if (ts.isTypeNode(current)) {
      return true;
    }
    if (ts.isHeritageClause(current)) {
      return true;
    }
    if (ts.isStatement(current) || ts.isExpression(current)) {
      return false;
    }
  }
  return false;
}

function isDeclarationName(identifier) {
  const parent = identifier.parent;
  return (
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
    (ts.isFunctionExpression(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassExpression(parent) && parent.name === identifier) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === identifier) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === identifier) ||
    (ts.isEnumDeclaration(parent) && parent.name === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    (ts.isBreakOrContinueStatement(parent) && parent.label === identifier)
  );
}

function isRuntimeIdentifier(identifier) {
  return (
    !isInsideImportOrExport(identifier) &&
    !isTypePosition(identifier) &&
    !isDeclarationName(identifier)
  );
}

function visitSourceFiles(sourceFiles, visitor) {
  for (const sourceFile of sourceFiles) {
    function visit(node) {
      visitor(node, sourceFile);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${position.line + 1}:${position.character + 1}`;
}

export async function analyzeProductionSources(rootDirectory, sourceEntries, forbiddenModules) {
  const sources = await Promise.all(
    sourceEntries.map(async (entry) => ({
      ...entry,
      text: entry.text ?? (await readFile(entry.absolutePath, 'utf8')),
    })),
  );
  const { program, sourceByProgramPath } = createProgram(rootDirectory, sources);
  const checker = program.getTypeChecker();
  const sourceFiles = [];
  const entryBySourceFile = new Map();
  for (const [programPath, entry] of sourceByProgramPath) {
    const sourceFile = program.getSourceFile(programPath);
    if (!sourceFile) {
      throw new Error(
        `TypeScript could not parse tracked production source: ${entry.relativePath}`,
      );
    }
    sourceFiles.push(sourceFile);
    entryBySourceFile.set(sourceFile, entry);
  }

  const inventories = new Map(
    sourceFiles.map((sourceFile) => [
      sourceFile,
      { providerCalls: {}, providerImports: {}, providerUses: {} },
    ]),
  );
  const provenance = new Map();
  const directImportRecords = [];
  const localImportRecords = [];
  const localExportRecords = [];
  const importEqualsRecords = [];
  const localLoaderRecords = [];
  const exportedOrigins = new Map(sourceFiles.map((sourceFile) => [sourceFile, new Map()]));
  const loaderAliases = new Set();
  const createRequireSymbols = new Set();
  const nodeModuleNamespaceSymbols = new Set();
  const loaderReturningFunctions = new Set();
  const loaderOrigins = new Map();
  const trustedLoaderCounts = new Map();

  function originsForSymbol(symbol) {
    if (!symbol) return new Set();
    const direct = provenance.get(symbol) ?? new Set();
    const target = aliasedSymbol(checker, symbol);
    return target ? union(direct, provenance.get(target) ?? new Set()) : direct;
  }

  function addOrigins(symbol, values) {
    if (!symbol || values.size === 0) return false;
    const existing = provenance.get(symbol) ?? new Set();
    const size = existing.size;
    for (const value of values) existing.add(value);
    provenance.set(symbol, existing);
    return existing.size !== size;
  }

  function addImport(sourceFile, value) {
    increment(inventories.get(sourceFile).providerImports, `import:${value}`);
  }

  function addExportOrigins(sourceFile, exportedName, values) {
    if (values.size === 0) return false;
    const exports = exportedOrigins.get(sourceFile);
    const existing = exports.get(exportedName) ?? new Set();
    const size = existing.size;
    for (const value of values) existing.add(value);
    exports.set(exportedName, existing);
    return existing.size !== size;
  }

  function sourceRelativePath(sourceFile) {
    return entryBySourceFile.get(sourceFile)?.relativePath ?? '';
  }

  function recordDirectBinding(sourceFile, symbol, values) {
    if (!symbol) return;
    addOrigins(symbol, values);
    directImportRecords.push({ sourceFile, symbol, values });
  }

  function collectImportDeclaration(statement, sourceFile) {
    const requestedModule = moduleName(statement.moduleSpecifier);
    if (!requestedModule) return;
    if (
      (requestedModule === 'node:module' || requestedModule === 'module') &&
      statement.importClause &&
      !statement.importClause.isTypeOnly
    ) {
      if (statement.importClause.name) {
        const symbol = symbolAt(checker, statement.importClause.name);
        if (symbol) nodeModuleNamespaceSymbols.add(symbol);
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        const symbol = symbolAt(checker, bindings.name);
        if (symbol) nodeModuleNamespaceSymbols.add(symbol);
      } else if (bindings) {
        for (const specifier of bindings.elements) {
          if (
            !specifier.isTypeOnly &&
            (specifier.propertyName?.text ?? specifier.name.text) === 'createRequire'
          ) {
            const symbol = symbolAt(checker, specifier.name);
            if (symbol) createRequireSymbols.add(symbol);
          }
        }
      }
    }
    const forbiddenModule = resolveForbiddenModule(
      requestedModule,
      forbiddenModules,
      sourceRelativePath(sourceFile),
    );
    if (!forbiddenModule) {
      if (statement.importClause && !statement.importClause.isTypeOnly) {
        if (statement.importClause.name) {
          localImportRecords.push({
            importedName: 'default',
            moduleSpecifier: requestedModule,
            sourceFile,
            symbol: symbolAt(checker, statement.importClause.name),
          });
        }
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          localImportRecords.push({
            importedName: '*',
            moduleSpecifier: requestedModule,
            sourceFile,
            symbol: symbolAt(checker, bindings.name),
          });
        } else if (bindings) {
          for (const specifier of bindings.elements) {
            if (!specifier.isTypeOnly) {
              localImportRecords.push({
                importedName: specifier.propertyName?.text ?? specifier.name.text,
                moduleSpecifier: requestedModule,
                sourceFile,
                symbol: symbolAt(checker, specifier.name),
              });
            }
          }
        }
      }
      return;
    }
    if (!statement.importClause) {
      addImport(sourceFile, origin(forbiddenModule, '<side-effect>'));
      return;
    }
    if (statement.importClause.isTypeOnly) return;
    if (statement.importClause.name) {
      recordDirectBinding(
        sourceFile,
        symbolAt(checker, statement.importClause.name),
        new Set([origin(forbiddenModule, 'default')]),
      );
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      recordDirectBinding(
        sourceFile,
        symbolAt(checker, bindings.name),
        new Set([origin(forbiddenModule, '*')]),
      );
    } else if (bindings) {
      for (const specifier of bindings.elements) {
        if (specifier.isTypeOnly) continue;
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        recordDirectBinding(
          sourceFile,
          symbolAt(checker, specifier.name),
          new Set([origin(forbiddenModule, importedName)]),
        );
      }
    }
  }

  function collectExportDeclaration(statement, sourceFile) {
    if (statement.isTypeOnly) return;
    const requestedModule = statement.moduleSpecifier
      ? moduleName(statement.moduleSpecifier)
      : undefined;
    const forbiddenModule = requestedModule
      ? resolveForbiddenModule(requestedModule, forbiddenModules, sourceRelativePath(sourceFile))
      : undefined;
    if (!forbiddenModule) {
      localExportRecords.push({ sourceFile, statement });
      return;
    }
    if (!statement.exportClause) {
      const values = new Set([origin(forbiddenModule, '*')]);
      addImport(sourceFile, origin(forbiddenModule, '*'));
      addExportOrigins(sourceFile, '*', values);
      return;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      addImport(sourceFile, origin(forbiddenModule, '*'));
      addOrigins(
        symbolAt(checker, statement.exportClause.name),
        new Set([origin(forbiddenModule, '*')]),
      );
      addExportOrigins(
        sourceFile,
        statement.exportClause.name.text,
        new Set([origin(forbiddenModule, '*')]),
      );
      return;
    }
    for (const specifier of statement.exportClause.elements) {
      if (specifier.isTypeOnly) continue;
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      const values = new Set([origin(forbiddenModule, importedName)]);
      addImport(sourceFile, origin(forbiddenModule, importedName));
      addOrigins(symbolAt(checker, specifier.name), values);
      if (specifier.propertyName) addOrigins(symbolAt(checker, specifier.propertyName), values);
      addExportOrigins(sourceFile, specifier.name.text, values);
    }
  }

  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        collectImportDeclaration(statement, sourceFile);
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference)
      ) {
        importEqualsRecords.push({ sourceFile, statement });
        const requestedModule = moduleName(statement.moduleReference.expression);
        if (requestedModule === 'node:module' || requestedModule === 'module') {
          const symbol = symbolAt(checker, statement.name);
          if (symbol) nodeModuleNamespaceSymbols.add(symbol);
        }
      } else if (ts.isExportDeclaration(statement)) {
        collectExportDeclaration(statement, sourceFile);
      }
    }
  }

  function symbolIsLoader(symbol) {
    return !!symbol && loaderAliases.has(symbol);
  }

  function isUnshadowedIdentifier(identifier, expectedName) {
    if (identifier.text !== expectedName) return false;
    const symbol = symbolAt(checker, identifier);
    return (
      !symbol ||
      (symbol.declarations ?? []).every(
        (declaration) => declaration.getSourceFile().isDeclarationFile,
      )
    );
  }

  function isModuleRequire(expression) {
    const current = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(current)) {
      return (
        current.name.text === 'require' &&
        ts.isIdentifier(unwrapExpression(current.expression)) &&
        isUnshadowedIdentifier(unwrapExpression(current.expression), 'module')
      );
    }
    return (
      ts.isElementAccessExpression(current) &&
      current.argumentExpression &&
      ts.isStringLiteralLike(current.argumentExpression) &&
      current.argumentExpression.text === 'require' &&
      ts.isIdentifier(unwrapExpression(current.expression)) &&
      isUnshadowedIdentifier(unwrapExpression(current.expression), 'module')
    );
  }

  function isLoaderCallee(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      return (
        isUnshadowedIdentifier(current, 'require') || symbolIsLoader(symbolAt(checker, current))
      );
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return isLoaderValue(current.right);
    }
    if (ts.isConditionalExpression(current)) {
      return isLoaderValue(current.whenTrue) || isLoaderValue(current.whenFalse);
    }
    if (ts.isCallExpression(current)) {
      return (
        isLoaderBindCall(current) ||
        calledFunctionLikes(current).some((functionLike) =>
          loaderReturningFunctions.has(functionLike),
        )
      );
    }
    return isModuleRequire(current);
  }

  function isLoaderBindCall(callExpression) {
    const callee = unwrapExpression(callExpression.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
      return isLoaderValue(callee.expression);
    }
    return (
      ts.isElementAccessExpression(callee) &&
      callee.argumentExpression &&
      ts.isStringLiteralLike(callee.argumentExpression) &&
      callee.argumentExpression.text === 'bind' &&
      isLoaderValue(callee.expression)
    );
  }

  function isCreateRequireCallee(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      return createRequireSymbols.has(symbolAt(checker, current));
    }
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'createRequire') {
      return isNodeModuleNamespaceValue(current.expression);
    }
    if (
      ts.isElementAccessExpression(current) &&
      current.argumentExpression &&
      ts.isStringLiteralLike(current.argumentExpression) &&
      current.argumentExpression.text === 'createRequire'
    ) {
      return isNodeModuleNamespaceValue(current.expression);
    }
    return false;
  }

  function isNodeModuleLoaderCall(expression) {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current) || !isLoaderCallee(current.expression)) return false;
    const target = current.arguments[0];
    return !!target && isNodeModuleTarget(target);
  }

  function isNodeModuleTarget(expression) {
    const targets = staticTargets(expression, new Set(), false);
    return (
      !!targets && [...targets].some((target) => target === 'node:module' || target === 'module')
    );
  }

  function isNodeModuleNamespaceValue(expression) {
    const current = unwrapExpression(expression);
    if (ts.isAwaitExpression(current)) return isNodeModuleNamespaceValue(current.expression);
    if (ts.isIdentifier(current)) {
      return nodeModuleNamespaceSymbols.has(symbolAt(checker, current));
    }
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = current.arguments[0];
      return !!target && isNodeModuleTarget(target);
    }
    return isNodeModuleLoaderCall(current);
  }

  function isLoaderValue(expression) {
    const current = unwrapExpression(expression);
    if (isLoaderCallee(current)) return true;
    if (ts.isCallExpression(current)) return isCreateRequireCallee(current.expression);
    return false;
  }

  function functionLikesFromDeclaration(declaration) {
    if (ts.isFunctionLike(declaration) && declaration.body) return [declaration];
    if (
      (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return [declaration.initializer];
    }
    if (
      ts.isPropertyAssignment(declaration) &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return [declaration.initializer];
    }
    return [];
  }

  function calledFunctionLikes(callExpression) {
    const callee = unwrapExpression(callExpression.expression);
    let location;
    if (ts.isIdentifier(callee)) {
      location = callee;
    } else if (ts.isPropertyAccessExpression(callee)) {
      location = callee.name;
    } else if (
      ts.isElementAccessExpression(callee) &&
      callee.argumentExpression &&
      ts.isStringLiteralLike(callee.argumentExpression)
    ) {
      location = callee.argumentExpression;
    }
    const symbol = location ? symbolAt(checker, location) : undefined;
    const target = aliasedSymbol(checker, symbol) ?? symbol;
    return [
      ...new Set(
        (target?.declarations ?? [])
          .filter((declaration) => entryBySourceFile.has(declaration.getSourceFile()))
          .flatMap(functionLikesFromDeclaration),
      ),
    ];
  }

  function functionReturnsLoader(functionLike) {
    if (ts.isArrowFunction(functionLike) && !ts.isBlock(functionLike.body)) {
      return isLoaderValue(functionLike.body);
    }
    if (!functionLike.body || !ts.isBlock(functionLike.body)) return false;
    let returnsLoader = false;
    function visit(node) {
      if (returnsLoader || (node !== functionLike && ts.isFunctionLike(node))) return;
      if (ts.isReturnStatement(node) && node.expression && isLoaderValue(node.expression)) {
        returnsLoader = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(functionLike.body);
    return returnsLoader;
  }

  function propagateLoaderArguments(callExpression) {
    let changed = false;
    for (const functionLike of calledFunctionLikes(callExpression)) {
      callExpression.arguments.forEach((argument, index) => {
        if (!isLoaderValue(argument)) return;
        const parameter =
          functionLike.parameters[index] ??
          (functionLike.parameters.at(-1)?.dotDotDotToken
            ? functionLike.parameters.at(-1)
            : undefined);
        if (parameter && ts.isIdentifier(parameter.name)) {
          changed = addLoaderIdentifier(parameter.name) || changed;
        }
      });
    }
    return changed;
  }

  function addLoaderIdentifier(identifier) {
    const symbol = symbolAt(checker, identifier);
    if (!symbol || loaderAliases.has(symbol)) return false;
    loaderAliases.add(symbol);
    return true;
  }

  function addCreateRequireIdentifier(identifier) {
    const symbol = symbolAt(checker, identifier);
    if (!symbol || createRequireSymbols.has(symbol)) return false;
    createRequireSymbols.add(symbol);
    return true;
  }

  function addNodeModuleNamespaceIdentifier(identifier) {
    const symbol = symbolAt(checker, identifier);
    if (!symbol || nodeModuleNamespaceSymbols.has(symbol)) return false;
    nodeModuleNamespaceSymbols.add(symbol);
    return true;
  }

  function addCreateRequireDestructuredFactories(target) {
    const current = unwrapExpression(target);
    const properties = ts.isObjectBindingPattern(current)
      ? current.elements
      : ts.isObjectLiteralExpression(current)
        ? current.properties
        : [];
    let changed = false;
    for (const property of properties) {
      if (ts.isBindingElement(property)) {
        const propertyName = property.propertyName?.getText() ?? property.name.getText();
        if (propertyName === 'createRequire' && ts.isIdentifier(property.name)) {
          changed = addCreateRequireIdentifier(property.name) || changed;
        }
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === 'createRequire'
      ) {
        changed = addCreateRequireIdentifier(property.name) || changed;
      } else if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === 'createRequire' &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        changed = addCreateRequireIdentifier(unwrapExpression(property.initializer)) || changed;
      }
    }
    return changed;
  }

  function addModuleDestructuredLoaders(target) {
    const current = unwrapExpression(target);
    if (ts.isObjectBindingPattern(current)) {
      let changed = false;
      for (const element of current.elements) {
        const propertyName = element.propertyName?.getText() ?? element.name.getText();
        if (propertyName === 'require' && ts.isIdentifier(element.name)) {
          changed = addLoaderIdentifier(element.name) || changed;
        }
      }
      return changed;
    }
    if (!ts.isObjectLiteralExpression(current)) return false;
    let changed = false;
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'require') {
        changed = addLoaderIdentifier(property.name) || changed;
      } else if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === 'require' &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        changed = addLoaderIdentifier(unwrapExpression(property.initializer)) || changed;
      }
    }
    return changed;
  }

  let loaderChanged = true;
  while (loaderChanged) {
    loaderChanged = false;
    visitSourceFiles(sourceFiles, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isNodeModuleNamespaceValue(node.initializer)
      ) {
        loaderChanged = addNodeModuleNamespaceIdentifier(node.name) || loaderChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.left)) &&
        isNodeModuleNamespaceValue(node.right)
      ) {
        loaderChanged =
          addNodeModuleNamespaceIdentifier(unwrapExpression(node.left)) || loaderChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isCreateRequireCallee(node.initializer)
      ) {
        loaderChanged = addCreateRequireIdentifier(node.name) || loaderChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.left)) &&
        isCreateRequireCallee(node.right)
      ) {
        loaderChanged = addCreateRequireIdentifier(unwrapExpression(node.left)) || loaderChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isNodeModuleNamespaceValue(node.initializer)
      ) {
        loaderChanged = addCreateRequireDestructuredFactories(node.name) || loaderChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isNodeModuleNamespaceValue(node.right)
      ) {
        loaderChanged = addCreateRequireDestructuredFactories(node.left) || loaderChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isLoaderValue(node.initializer)
      ) {
        loaderChanged = addLoaderIdentifier(node.name) || loaderChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.left)) &&
        isLoaderValue(node.right)
      ) {
        loaderChanged = addLoaderIdentifier(unwrapExpression(node.left)) || loaderChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(unwrapExpression(node.initializer)) &&
        isUnshadowedIdentifier(unwrapExpression(node.initializer), 'module')
      ) {
        loaderChanged = addModuleDestructuredLoaders(node.name) || loaderChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.right)) &&
        isUnshadowedIdentifier(unwrapExpression(node.right), 'module')
      ) {
        loaderChanged = addModuleDestructuredLoaders(node.left) || loaderChanged;
      }
      if (ts.isCallExpression(node)) {
        loaderChanged = propagateLoaderArguments(node) || loaderChanged;
      }
      if (
        ts.isFunctionLike(node) &&
        node.body &&
        !loaderReturningFunctions.has(node) &&
        functionReturnsLoader(node)
      ) {
        loaderReturningFunctions.add(node);
        loaderChanged = true;
      }
    });
  }

  function staticTargets(expression, seenSymbols = new Set(), allowTrustedLoaders = true) {
    const current = unwrapExpression(expression);
    if (ts.isStringLiteralLike(current)) return new Set([current.text]);
    if (ts.isTemplateExpression(current)) {
      let values = new Set([current.head.text]);
      for (const span of current.templateSpans) {
        const expressionValues = staticTargets(span.expression, seenSymbols, allowTrustedLoaders);
        if (!expressionValues) return undefined;
        values = new Set(
          [...values].flatMap((prefix) =>
            [...expressionValues].map((value) => `${prefix}${value}${span.literal.text}`),
          ),
        );
      }
      return values;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticTargets(current.left, seenSymbols, allowTrustedLoaders);
      const right = staticTargets(current.right, seenSymbols, allowTrustedLoaders);
      if (!left || !right) return undefined;
      return new Set([...left].flatMap((prefix) => [...right].map((value) => prefix + value)));
    }
    if (ts.isConditionalExpression(current)) {
      const whenTrue = staticTargets(current.whenTrue, seenSymbols, allowTrustedLoaders);
      const whenFalse = staticTargets(current.whenFalse, seenSymbols, allowTrustedLoaders);
      return whenTrue && whenFalse ? union(whenTrue, whenFalse) : undefined;
    }
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(checker, current);
      if (!symbol || seenSymbols.has(symbol)) return undefined;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0
      ) {
        return staticTargets(
          declaration.initializer,
          new Set([...seenSymbols, symbol]),
          allowTrustedLoaders,
        );
      }
      return undefined;
    }
    if (allowTrustedLoaders && ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'realpathSync' &&
        ts.isIdentifier(unwrapExpression(callee.expression)) &&
        isNamespaceImportFrom(unwrapExpression(callee.expression), 'node:fs') &&
        current.arguments[0] &&
        isTrustedTypeScriptCompilerPath(current.arguments[0])
      ) {
        return new Set(['@typescript/typescript-runtime']);
      }
      if (isTrustedPlaywrightEntryPath(current)) {
        return new Set(['playwright']);
      }
    }
    return undefined;
  }

  function isNamespaceImportFrom(identifier, expectedModule) {
    const symbol = symbolAt(checker, identifier);
    return (symbol?.declarations ?? []).some((declaration) => {
      if (!ts.isNamespaceImport(declaration)) return false;
      let current = declaration.parent;
      while (current && !ts.isSourceFile(current)) {
        if (ts.isImportDeclaration(current)) {
          return moduleName(current.moduleSpecifier) === expectedModule;
        }
        current = current.parent;
      }
      return false;
    });
  }

  function isTrustedTypeScriptCompilerPath(expression) {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current)) return false;
    const loaderEntry = entryBySourceFile.get(current.getSourceFile());
    if (!loaderEntry || !TRUSTED_TYPESCRIPT_LOADER_PATHS.has(loaderEntry.relativePath)) {
      return false;
    }
    const callee = unwrapExpression(current.expression);
    if (!ts.isIdentifier(callee) || callee.text !== 'getTypeScriptCompilerPath') return false;
    const target = aliasedSymbol(checker, symbolAt(checker, callee));
    const trustedResolver = (target?.declarations ?? []).some((declaration) => {
      const sourceFile = declaration.getSourceFile();
      const entry = entryBySourceFile.get(sourceFile);
      if (
        entry?.relativePath !== TRUSTED_TYPESCRIPT_RESOLVER ||
        !ts.isFunctionDeclaration(declaration) ||
        declaration.parameters.length !== 1 ||
        !declaration.body ||
        declaration.body.statements.length !== 1
      ) {
        return false;
      }
      const parameter = declaration.parameters[0].name;
      const returnStatement = declaration.body.statements[0];
      if (
        !ts.isIdentifier(parameter) ||
        !ts.isReturnStatement(returnStatement) ||
        !returnStatement.expression ||
        !ts.isCallExpression(returnStatement.expression)
      ) {
        return false;
      }
      const resolverCall = returnStatement.expression;
      return (
        ts.isIdentifier(resolverCall.expression) &&
        resolverCall.expression.text === 'getNodeModuleEntryPath' &&
        resolverCall.arguments.length === 2 &&
        ts.isIdentifier(resolverCall.arguments[0]) &&
        resolverCall.arguments[0].text === parameter.text &&
        ts.isStringLiteralLike(resolverCall.arguments[1]) &&
        resolverCall.arguments[1].text === 'lib/typescript.js'
      );
    });
    const trustedCount = trustedLoaderCounts.get(loaderEntry.relativePath) ?? 0;
    if (!trustedResolver || trustedCount >= 1) return false;
    trustedLoaderCounts.set(loaderEntry.relativePath, trustedCount + 1);
    return true;
  }

  function isTrustedPlaywrightEntryPath(expression) {
    const loaderEntry = entryBySourceFile.get(expression.getSourceFile());
    if (loaderEntry?.relativePath !== TRUSTED_PLAYWRIGHT_LOADER) return false;
    const trustedCount = trustedLoaderCounts.get(TRUSTED_PLAYWRIGHT_LOADER) ?? 0;
    if (trustedCount >= 1 || expression.arguments.length !== 1) return false;
    const entryResolver = unwrapExpression(expression.arguments[0]);
    if (
      !ts.isCallExpression(entryResolver) ||
      !ts.isIdentifier(entryResolver.expression) ||
      entryResolver.expression.text !== 'getNodeModuleEntryPath' ||
      entryResolver.arguments.length !== 2 ||
      !ts.isStringLiteralLike(entryResolver.arguments[1]) ||
      entryResolver.arguments[1].text !== 'index.js' ||
      !ts.isIdentifier(entryResolver.arguments[0])
    ) {
      return false;
    }
    const packagePathSymbol = symbolAt(checker, entryResolver.arguments[0]);
    const declaration = packagePathSymbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return false;
    }
    const packageResolver = unwrapExpression(declaration.initializer);
    if (
      !ts.isCallExpression(packageResolver) ||
      !ts.isIdentifier(packageResolver.expression) ||
      packageResolver.expression.text !== 'resolveNodeModulePackageJsonPathSync' ||
      packageResolver.arguments.length !== 2 ||
      !ts.isArrayLiteralExpression(packageResolver.arguments[1]) ||
      packageResolver.arguments[1].elements.length !== 1 ||
      !ts.isStringLiteralLike(packageResolver.arguments[1].elements[0]) ||
      packageResolver.arguments[1].elements[0].text !== 'playwright'
    ) {
      return false;
    }
    trustedLoaderCounts.set(TRUSTED_PLAYWRIGHT_LOADER, trustedCount + 1);
    return true;
  }

  for (const { sourceFile, statement } of importEqualsRecords) {
    const targetExpression = statement.moduleReference.expression;
    const targets = targetExpression ? staticTargets(targetExpression) : undefined;
    if (!targets) {
      addImport(sourceFile, `unresolved-loader:${lineAndColumn(sourceFile, statement)}`);
      continue;
    }
    const values = new Set();
    for (const target of targets) {
      const forbiddenModule = resolveForbiddenModule(
        target,
        forbiddenModules,
        sourceRelativePath(sourceFile),
      );
      if (forbiddenModule) values.add(origin(forbiddenModule, '*'));
    }
    recordDirectBinding(sourceFile, symbolAt(checker, statement.name), values);
  }

  visitSourceFiles(sourceFiles, (node, sourceFile) => {
    if (!ts.isCallExpression(node)) return;
    const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    if (!dynamicImport && !isLoaderCallee(node.expression)) return;
    const targetExpression = node.arguments[0];
    const targets = targetExpression ? staticTargets(targetExpression) : undefined;
    if (!targets) {
      const detail = `unresolved-loader:${lineAndColumn(sourceFile, node)}`;
      addImport(sourceFile, detail);
      return;
    }
    const values = new Set();
    const localTargets = new Set();
    for (const target of targets) {
      const forbiddenModule = resolveForbiddenModule(
        target,
        forbiddenModules,
        sourceRelativePath(sourceFile),
      );
      if (forbiddenModule) {
        values.add(origin(forbiddenModule, '*'));
      } else {
        const localTarget = resolveLocalSourceFile(sourceFile, target);
        if (localTarget) localTargets.add(localTarget);
      }
    }
    if (values.size > 0) {
      loaderOrigins.set(node, values);
      for (const value of values) addImport(sourceFile, value.replace(/#\*$/, '#<dynamic>'));
    }
    if (localTargets.size > 0) {
      localLoaderRecords.push({ node, sourceFile, targetSourceFiles: localTargets });
    }
  });

  function expressionOrigins(expression) {
    const current = unwrapExpression(expression);
    if (loaderOrigins.has(current)) return loaderOrigins.get(current);
    if (ts.isIdentifier(current)) return originsForSymbol(symbolAt(checker, current));
    if (ts.isPropertyAccessExpression(current)) {
      const propertyOrigins = originsForSymbol(symbolAt(checker, current.name));
      return propertyOrigins.size > 0
        ? propertyOrigins
        : appendMember(expressionOrigins(current.expression), current.name.text);
    }
    if (ts.isElementAccessExpression(current)) {
      const argument = current.argumentExpression;
      const propertyOrigins = argument ? originsForSymbol(symbolAt(checker, argument)) : new Set();
      if (propertyOrigins.size > 0) return propertyOrigins;
      return argument && ts.isStringLiteralLike(argument)
        ? appendMember(expressionOrigins(current.expression), argument.text)
        : expressionOrigins(current.expression);
    }
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      return expressionOrigins(current.expression);
    }
    if (ts.isAwaitExpression(current)) return expressionOrigins(current.expression);
    if (ts.isConditionalExpression(current)) {
      return union(expressionOrigins(current.whenTrue), expressionOrigins(current.whenFalse));
    }
    if (ts.isBinaryExpression(current)) return expressionOrigins(current.right);
    if (ts.isArrayLiteralExpression(current)) {
      return union(...current.elements.map((element) => expressionOrigins(element)));
    }
    if (ts.isObjectLiteralExpression(current)) {
      return union(
        ...current.properties.map((property) => {
          if (ts.isPropertyAssignment(property)) return expressionOrigins(property.initializer);
          if (ts.isShorthandPropertyAssignment(property)) {
            return originsForSymbol(symbolAt(checker, property.name));
          }
          if (ts.isSpreadAssignment(property)) return expressionOrigins(property.expression);
          return new Set();
        }),
      );
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return returnOrigins(current);
    }
    return new Set();
  }

  function returnOrigins(functionLike) {
    if (ts.isArrowFunction(functionLike) && !ts.isBlock(functionLike.body)) {
      return expressionOrigins(functionLike.body);
    }
    if (!functionLike.body || !ts.isBlock(functionLike.body)) return new Set();
    const values = new Set();
    function visit(node) {
      if (node !== functionLike && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) {
        for (const value of expressionOrigins(node.expression)) values.add(value);
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(functionLike.body);
    return values;
  }

  function addBindingOrigins(name, values) {
    let changed = false;
    if (ts.isIdentifier(name)) return addOrigins(symbolAt(checker, name), values);
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const propertyName = element.propertyName?.getText() ?? element.name.getText();
        changed = addBindingOrigins(element.name, appendMember(values, propertyName)) || changed;
      }
    } else {
      name.elements.forEach((element, index) => {
        if (ts.isBindingElement(element)) {
          changed = addBindingOrigins(element.name, appendMember(values, String(index))) || changed;
        }
      });
    }
    return changed;
  }

  function propertyNameText(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return name.getText();
  }

  function addAssignmentOrigins(target, values) {
    const current = unwrapExpression(target);
    if (ts.isIdentifier(current)) return addOrigins(symbolAt(checker, current), values);
    let assignmentChanged = false;
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          assignmentChanged =
            addOrigins(
              symbolAt(checker, property.name),
              appendMember(values, property.name.text),
            ) || assignmentChanged;
        } else if (ts.isPropertyAssignment(property)) {
          assignmentChanged =
            addAssignmentOrigins(
              property.initializer,
              appendMember(values, propertyNameText(property.name)),
            ) || assignmentChanged;
        } else if (ts.isSpreadAssignment(property)) {
          assignmentChanged =
            addAssignmentOrigins(property.expression, values) || assignmentChanged;
        }
      }
    } else if (ts.isArrayLiteralExpression(current)) {
      current.elements.forEach((element, index) => {
        if (!ts.isOmittedExpression(element)) {
          assignmentChanged =
            addAssignmentOrigins(element, appendMember(values, String(index))) || assignmentChanged;
        }
      });
    }
    return assignmentChanged;
  }

  function resolveLocalSourceFile(sourceFile, requestedModule) {
    if (!requestedModule) return undefined;
    const basePaths = [];
    if (requestedModule.startsWith('.')) {
      basePaths.push(path.resolve(path.dirname(sourceFile.fileName), requestedModule));
    } else if (requestedModule.startsWith('@/')) {
      basePaths.push(path.resolve(rootDirectory, 'apps/desktop/src', requestedModule.slice(2)));
    } else if (requestedModule.startsWith('#')) {
      for (const resolved of resolvePackageImportTargets(
        requestedModule,
        forbiddenModules,
        sourceRelativePath(sourceFile),
      )) {
        if (resolved.target.startsWith('./')) {
          basePaths.push(path.resolve(rootDirectory, resolved.packageDirectory, resolved.target));
        }
      }
    } else {
      return undefined;
    }
    const programPath = basePaths
      .flatMap((basePath) => localModuleCandidates(basePath))
      .find((candidate) => sourceByProgramPath.has(path.resolve(candidate)));
    return programPath ? program.getSourceFile(programPath) : undefined;
  }

  function exportedValues(sourceFile, exportedName) {
    const exports = exportedOrigins.get(sourceFile);
    if (!exports) return new Set();
    const exact = exports.get(exportedName) ?? new Set();
    const wildcard = exports.get('*') ?? new Set();
    return exportedName === '*'
      ? union(...exports.values())
      : union(exact, appendMember(wildcard, exportedName));
  }

  function propagateLocalLoaders() {
    let loaderOriginsChanged = false;
    for (const record of localLoaderRecords) {
      const values = union(
        ...[...record.targetSourceFiles].map((targetSourceFile) =>
          exportedValues(targetSourceFile, '*'),
        ),
      );
      if (values.size === 0) continue;
      const existing = loaderOrigins.get(record.node) ?? new Set();
      const size = existing.size;
      for (const value of values) existing.add(value);
      loaderOrigins.set(record.node, existing);
      loaderOriginsChanged = existing.size !== size || loaderOriginsChanged;
    }
    return loaderOriginsChanged;
  }

  function hasModifier(node, kind) {
    return !!node.modifiers?.some((modifier) => modifier.kind === kind);
  }

  function propagateExports() {
    let exportChanged = false;
    for (const sourceFile of sourceFiles) {
      for (const statement of sourceFile.statements) {
        if (
          ts.isVariableStatement(statement) &&
          hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        ) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exportChanged =
                addExportOrigins(
                  sourceFile,
                  declaration.name.text,
                  originsForSymbol(symbolAt(checker, declaration.name)),
                ) || exportChanged;
            }
          }
        } else if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
          statement.name
        ) {
          const exportedName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
            ? 'default'
            : statement.name.text;
          exportChanged =
            addExportOrigins(
              sourceFile,
              exportedName,
              originsForSymbol(symbolAt(checker, statement.name)),
            ) || exportChanged;
        } else if (ts.isExportAssignment(statement)) {
          exportChanged =
            addExportOrigins(sourceFile, 'default', expressionOrigins(statement.expression)) ||
            exportChanged;
        }
      }
    }
    for (const { sourceFile, statement } of localExportRecords) {
      if (statement.isTypeOnly) continue;
      const targetSourceFile = statement.moduleSpecifier
        ? resolveLocalSourceFile(sourceFile, moduleName(statement.moduleSpecifier))
        : sourceFile;
      if (!targetSourceFile) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          if (specifier.isTypeOnly) continue;
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          exportChanged =
            addExportOrigins(
              sourceFile,
              specifier.name.text,
              exportedValues(targetSourceFile, importedName),
            ) || exportChanged;
        }
      } else if (!statement.exportClause) {
        exportChanged =
          addExportOrigins(sourceFile, '*', exportedValues(targetSourceFile, '*')) || exportChanged;
      }
    }
    for (const record of localImportRecords) {
      const targetSourceFile = resolveLocalSourceFile(record.sourceFile, record.moduleSpecifier);
      if (targetSourceFile) {
        exportChanged =
          addOrigins(record.symbol, exportedValues(targetSourceFile, record.importedName)) ||
          exportChanged;
      }
    }
    return exportChanged;
  }

  let changed = true;
  while (changed) {
    changed = false;
    visitSourceFiles(sourceFiles, (node) => {
      if (ts.isIdentifier(node)) {
        const symbol = symbolAt(checker, node);
        const target = aliasedSymbol(checker, symbol);
        if (target) changed = addOrigins(symbol, originsForSymbol(target)) || changed;
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        changed = addBindingOrigins(node.name, expressionOrigins(node.initializer)) || changed;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        changed = addAssignmentOrigins(node.left, expressionOrigins(node.right)) || changed;
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        changed = addOrigins(symbolAt(checker, node.name), returnOrigins(node)) || changed;
      } else if (ts.isPropertyAssignment(node)) {
        changed =
          addOrigins(symbolAt(checker, node.name), expressionOrigins(node.initializer)) || changed;
      } else if (ts.isPropertyDeclaration(node) && node.initializer) {
        changed =
          addOrigins(symbolAt(checker, node.name), expressionOrigins(node.initializer)) || changed;
      }
    });
    changed = propagateExports() || changed;
    changed = propagateLocalLoaders() || changed;
  }

  const runtimeSymbols = new Set();
  visitSourceFiles(sourceFiles, (node, sourceFile) => {
    if (!ts.isIdentifier(node) || !isRuntimeIdentifier(node)) return;
    const symbol = symbolAt(checker, node);
    const values = originsForSymbol(symbol);
    if (values.size === 0) return;
    if (symbol) runtimeSymbols.add(symbol);
    for (const value of values) increment(inventories.get(sourceFile).providerUses, `use:${value}`);
  });

  for (const record of directImportRecords) {
    for (const value of record.values) addImport(record.sourceFile, value);
  }
  for (const record of localImportRecords) {
    if (!runtimeSymbols.has(record.symbol)) continue;
    for (const value of originsForSymbol(record.symbol)) addImport(record.sourceFile, value);
  }
  for (const record of localLoaderRecords) {
    for (const value of loaderOrigins.get(record.node) ?? []) {
      addImport(record.sourceFile, value);
    }
  }

  for (const { sourceFile, statement } of localExportRecords) {
    if (statement.isTypeOnly) continue;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly) continue;
        const symbol = symbolAt(checker, specifier.propertyName ?? specifier.name);
        for (const value of originsForSymbol(symbol)) addImport(sourceFile, value);
      }
    } else if (statement.moduleSpecifier) {
      const moduleSymbol = symbolAt(checker, statement.moduleSpecifier);
      if (moduleSymbol) {
        for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
          for (const value of originsForSymbol(exportedSymbol)) addImport(sourceFile, value);
        }
      }
    }
  }

  visitSourceFiles(sourceFiles, (node, sourceFile) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (ts.isCallExpression(node) && loaderOrigins.has(node)) return;
      for (const value of expressionOrigins(node.expression)) {
        increment(inventories.get(sourceFile).providerCalls, `call:${value}`);
      }
    } else if (
      ts.isExpressionWithTypeArguments(node) &&
      ts.isHeritageClause(node.parent) &&
      node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
    ) {
      for (const value of expressionOrigins(node.expression)) {
        increment(inventories.get(sourceFile).providerCalls, `call:${value}`);
      }
    }
  });

  const inventory = {};
  for (const sourceFile of sourceFiles) {
    const fileInventory = inventories.get(sourceFile);
    if (
      Object.keys(fileInventory.providerCalls).length > 0 ||
      Object.keys(fileInventory.providerImports).length > 0 ||
      Object.keys(fileInventory.providerUses).length > 0
    ) {
      inventory[entryBySourceFile.get(sourceFile).relativePath] = fileInventory;
    }
  }
  return inventory;
}
