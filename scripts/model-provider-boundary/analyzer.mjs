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
const CALLABLE_LOADER = 1;
const CALLABLE_CREATE_REQUIRE = 2;
const CALLABLE_OBJECT_ASSIGN = 4;
const CALLABLE_INTRINSIC_CALL = 8;
const CALLABLE_INTRINSIC_APPLY = 16;
const CALLABLE_INTRINSIC_INVOCATION = CALLABLE_INTRINSIC_CALL | CALLABLE_INTRINSIC_APPLY;
const MAY_BE_TRUTHY = 1;
const MAY_BE_FALSY = 2;
const MAY_BE_NULLISH = 1;
const MAY_BE_NON_NULLISH = 2;

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
  const callableKindsBySymbol = new Map();
  const callableMembersBySymbol = new Map();
  const callableReturnsByFunction = new Map();
  const functionTargetsBySymbol = new Map();
  const functionMembersBySymbol = new Map();
  const containerSymbols = new Set();
  const arrayIdentitiesBySymbol = new Map();
  const memberReferencesBySymbol = new Map();
  const destructuringAssignmentsBySymbol = new Map();
  const nodeModuleNamespaceSymbols = new Set();
  const unresolvedLoaderExpressions = new Map();
  const loaderOrigins = new Map();
  const staticLoaderTargetsByCall = new Map();
  const trustedLoaderCounts = new Map();
  const contextualLoaderTargets = new Map();
  const contextualValueCache = new Map();
  const functionBodiesCreatingInstance = new Map();
  const runtimeClassInstances = new Map();
  const runtimeInstanceSymbols = new Map();
  const runtimeSymbolUsageBySourceFile = new Map();
  const readOnlyLiteralContainerSymbols = new Map();
  let collectLoaderContexts = false;

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
            addCallableKinds(symbol, CALLABLE_CREATE_REQUIRE);
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

  function isDefinitelyDefinedValue(expression, seenSymbols = new Set()) {
    const current = unwrapExpression(expression);
    if (
      current.kind === ts.SyntaxKind.NullKeyword ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isStringLiteralLike(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isTemplateExpression(current) ||
      ts.isNumericLiteral(current) ||
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isClassExpression(current) ||
      ts.isNewExpression(current) ||
      isModuleRequire(current)
    ) {
      return true;
    }
    if (ts.isIdentifier(current)) {
      if (current.text === 'undefined' && isUnshadowedIdentifier(current, 'undefined')) {
        return false;
      }
      if (isUnshadowedIdentifier(current, 'require')) return true;
      const symbol = symbolAt(checker, current);
      if (!symbol || seenSymbols.has(symbol)) return false;
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isFunctionLike(declaration) || ts.isClassDeclaration(declaration)) return true;
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0 &&
          isDefinitelyDefinedValue(declaration.initializer, new Set([...seenSymbols, symbol]))
        ) {
          return true;
        }
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const owner = unwrapExpression(current.expression);
      const memberNames = accessMemberNames(current);
      return (
        ts.isIdentifier(owner) &&
        isUnshadowedIdentifier(owner, 'console') &&
        !!memberNames &&
        [...memberNames].every((memberName) =>
          new Set(['debug', 'error', 'info', 'log', 'warn']).has(memberName),
        )
      );
    }
    if (ts.isConditionalExpression(current)) {
      return (
        isDefinitelyDefinedValue(current.whenTrue, seenSymbols) &&
        isDefinitelyDefinedValue(current.whenFalse, seenSymbols)
      );
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return isDefinitelyDefinedValue(current.right, seenSymbols);
    }
    return false;
  }

  function runtimeIdentifierUseIsReadOnly(identifier) {
    const parent = identifier.parent;
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === identifier
    ) {
      const operation = parent.parent;
      if (
        ts.isCallExpression(operation) &&
        operation.expression === parent &&
        [...(accessMemberNames(parent) ?? [])].some(
          (memberName) => memberName === 'push' || memberName === 'unshift',
        )
      ) {
        return false;
      }
      return !(
        (ts.isBinaryExpression(operation) && unwrapExpression(operation.left) === parent) ||
        (ts.isDeleteExpression(operation) && operation.expression === parent) ||
        ts.isPrefixUnaryExpression(operation) ||
        ts.isPostfixUnaryExpression(operation)
      );
    }
    if (ts.isSpreadAssignment(parent) && parent.expression === identifier) return true;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === identifier &&
      (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))
    ) {
      return true;
    }
    return (
      ts.isBinaryExpression(parent) &&
      parent.right === identifier &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isObjectLiteralExpression(unwrapExpression(parent.left)) ||
        ts.isArrayLiteralExpression(unwrapExpression(parent.left)))
    );
  }

  function runtimeSymbolUsage(sourceFile) {
    if (runtimeSymbolUsageBySourceFile.has(sourceFile)) {
      return runtimeSymbolUsageBySourceFile.get(sourceFile);
    }
    const usage = new Map();
    function visit(node) {
      if (ts.isIdentifier(node) && isRuntimeIdentifier(node)) {
        const symbol = symbolAt(checker, node);
        const identity = aliasedSymbol(checker, symbol) ?? symbol;
        if (identity) {
          const current = usage.get(identity) ?? { readOnly: true, referenceCount: 0 };
          current.referenceCount += 1;
          current.readOnly = current.readOnly && runtimeIdentifierUseIsReadOnly(node);
          usage.set(identity, current);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    runtimeSymbolUsageBySourceFile.set(sourceFile, usage);
    return usage;
  }

  function objectSpreadMembersAreKnown(expression, seenSymbols = new Set()) {
    const current = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.every((property) => {
        if (ts.isSpreadAssignment(property)) {
          return objectSpreadMembersAreKnown(property.expression, seenSymbols);
        }
        const memberNames = declarationMemberNames(property.name);
        return !!memberNames && memberNames.size === 1;
      });
    }
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(checker, current);
      const identity = aliasedSymbol(checker, symbol) ?? symbol;
      if (!identity || seenSymbols.has(identity)) return false;
      const usage = runtimeSymbolUsage(current.getSourceFile()).get(identity);
      if ((usage?.referenceCount ?? 0) > 1) return false;
      const declarations = identity.declarations ?? [];
      return (
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            ts.isVariableDeclaration(declaration) &&
            !!declaration.initializer &&
            (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0 &&
            objectSpreadMembersAreKnown(
              declaration.initializer,
              new Set([...seenSymbols, identity]),
            ),
        )
      );
    }
    if (ts.isConditionalExpression(current)) {
      return (
        objectSpreadMembersAreKnown(current.whenTrue, seenSymbols) &&
        objectSpreadMembersAreKnown(current.whenFalse, seenSymbols)
      );
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return objectSpreadMembersAreKnown(current.right, seenSymbols);
    }
    return false;
  }

  function definitelyPresentObjectSpreadMembers(expression, seenSymbols = new Set()) {
    const current = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(current)) {
      const members = new Set();
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const memberName of definitelyPresentObjectSpreadMembers(
            property.expression,
            seenSymbols,
          )) {
            members.add(memberName);
          }
          continue;
        }
        for (const memberName of declarationMemberNames(property.name) ?? []) {
          members.add(memberName);
        }
      }
      return members;
    }
    if (ts.isIdentifier(current)) {
      if (!objectSpreadMembersAreKnown(current)) return new Set();
      const symbol = symbolAt(checker, current);
      const identity = aliasedSymbol(checker, symbol) ?? symbol;
      if (!identity || seenSymbols.has(identity)) return new Set();
      const declarations = identity.declarations ?? [];
      const initializers = declarations
        .filter(
          (declaration) =>
            ts.isVariableDeclaration(declaration) &&
            !!declaration.initializer &&
            (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0,
        )
        .map((declaration) => declaration.initializer);
      if (initializers.length === 0 || initializers.length !== declarations.length) {
        return new Set();
      }
      const candidates = initializers.map((initializer) =>
        definitelyPresentObjectSpreadMembers(initializer, new Set([...seenSymbols, identity])),
      );
      return new Set(
        [...candidates[0]].filter((memberName) =>
          candidates.every((candidate) => candidate.has(memberName)),
        ),
      );
    }
    if (ts.isConditionalExpression(current)) {
      const whenTrue = definitelyPresentObjectSpreadMembers(current.whenTrue, seenSymbols);
      const whenFalse = definitelyPresentObjectSpreadMembers(current.whenFalse, seenSymbols);
      return new Set([...whenTrue].filter((memberName) => whenFalse.has(memberName)));
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return definitelyPresentObjectSpreadMembers(current.right, seenSymbols);
    }
    return new Set();
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
      staticPropertyNames(current.argumentExpression)?.has('require') &&
      ts.isIdentifier(unwrapExpression(current.expression)) &&
      isUnshadowedIdentifier(unwrapExpression(current.expression), 'module')
    );
  }

  function callableKindsForSymbol(symbol) {
    if (!symbol) return 0;
    const target = aliasedSymbol(checker, symbol);
    return (callableKindsBySymbol.get(symbol) ?? 0) | (callableKindsBySymbol.get(target) ?? 0);
  }

  function addCallableKinds(symbol, kinds) {
    if (!symbol || kinds === 0) return false;
    const existing = callableKindsBySymbol.get(symbol) ?? 0;
    const combined = existing | kinds;
    if (combined === existing) return false;
    callableKindsBySymbol.set(symbol, combined);
    return true;
  }

  function memberMapForSymbol(map, symbol) {
    const target = aliasedSymbol(checker, symbol);
    const maps = [map.get(symbol), map.get(target)].filter(Boolean);
    const combined = new Map();
    for (const members of maps) {
      for (const [name, value] of members) combined.set(name, (combined.get(name) ?? 0) | value);
    }
    return combined;
  }

  function memberSetMapForSymbol(map, symbol) {
    const target = aliasedSymbol(checker, symbol);
    const maps = [map.get(symbol), map.get(target)].filter(Boolean);
    const combined = new Map();
    for (const members of maps) {
      for (const [name, values] of members) {
        const existing = combined.get(name) ?? new Set();
        for (const value of values) existing.add(value);
        combined.set(name, existing);
      }
    }
    return combined;
  }

  function arrayIdentitiesForSymbol(symbol) {
    const identity = aliasedSymbol(checker, symbol) ?? symbol;
    return arrayIdentitiesBySymbol.get(identity) ?? new Set();
  }

  function addArrayIdentities(symbol, identities) {
    if (!symbol || identities.size === 0) return false;
    const identity = aliasedSymbol(checker, symbol) ?? symbol;
    const existing = arrayIdentitiesBySymbol.get(identity) ?? new Set();
    const size = existing.size;
    for (const container of identities) existing.add(container);
    arrayIdentitiesBySymbol.set(identity, existing);
    return existing.size !== size;
  }

  function addMemberKinds(symbol, memberNames, kinds) {
    if (!symbol || kinds === 0 || !memberNames || memberNames.size === 0) return false;
    containerSymbols.add(aliasedSymbol(checker, symbol) ?? symbol);
    const members = callableMembersBySymbol.get(symbol) ?? new Map();
    let changed = false;
    for (const memberName of memberNames) {
      const existing = members.get(memberName) ?? 0;
      const combined = existing | kinds;
      if (combined !== existing) {
        members.set(memberName, combined);
        changed = true;
      }
    }
    callableMembersBySymbol.set(symbol, members);
    return changed;
  }

  function addMemberFunctionTargets(symbol, memberNames, targets) {
    if (!symbol || targets.size === 0 || !memberNames || memberNames.size === 0) return false;
    const members = functionMembersBySymbol.get(symbol) ?? new Map();
    let changed = false;
    for (const memberName of memberNames) {
      const existing = members.get(memberName) ?? new Set();
      const size = existing.size;
      for (const target of targets) existing.add(target);
      members.set(memberName, existing);
      changed = existing.size !== size || changed;
    }
    functionMembersBySymbol.set(symbol, members);
    return changed;
  }

  function addMemberReferences(symbol, memberNames, references) {
    if (!symbol || references.size === 0 || !memberNames || memberNames.size === 0) return false;
    containerSymbols.add(aliasedSymbol(checker, symbol) ?? symbol);
    const members = memberReferencesBySymbol.get(symbol) ?? new Map();
    let changed = false;
    for (const memberName of memberNames) {
      const existing = members.get(memberName) ?? new Set();
      const size = existing.size;
      for (const reference of references) existing.add(reference);
      members.set(memberName, existing);
      changed = existing.size !== size || changed;
    }
    memberReferencesBySymbol.set(symbol, members);
    return changed;
  }

  function symbolForValue(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) return symbolAt(checker, current);
    if (ts.isPropertyAccessExpression(current)) return symbolAt(checker, current.name);
    if (ts.isElementAccessExpression(current)) {
      return symbolAt(checker, current) ?? symbolAt(checker, current.argumentExpression);
    }
    return undefined;
  }

  function staticPropertyNames(expression) {
    if (!expression) return undefined;
    const current = unwrapExpression(expression);
    if (ts.isNumericLiteral(current)) return new Set([current.text]);
    return staticTargets(current, new Set(), false);
  }

  function accessMemberNames(expression, environment, state) {
    const current = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(current)) return new Set([current.name.text]);
    if (ts.isElementAccessExpression(current))
      return (
        staticPropertyNames(current.argumentExpression) ??
        (environment
          ? callableValue(current.argumentExpression, environment, state).strings
          : undefined)
      );
    return undefined;
  }

  function memberKindsForOwner(owner, memberNames) {
    const current = unwrapExpression(owner);
    if (ts.isConditionalExpression(current)) {
      return (
        memberKindsForOwner(current.whenTrue, memberNames) |
        memberKindsForOwner(current.whenFalse, memberNames)
      );
    }
    const members = memberMapForSymbol(callableMembersBySymbol, symbolForValue(current));
    let kinds = members.get('*') ?? 0;
    if (memberNames) {
      for (const memberName of memberNames) kinds |= members.get(memberName) ?? 0;
    } else {
      for (const value of members.values()) kinds |= value;
    }
    return kinds;
  }

  function functionTargetsForSymbol(symbol) {
    if (!symbol) return new Set();
    const target = aliasedSymbol(checker, symbol);
    return union(
      functionTargetsBySymbol.get(symbol) ?? new Set(),
      functionTargetsBySymbol.get(target) ?? new Set(),
    );
  }

  function addFunctionTargets(symbol, targets) {
    if (!symbol || targets.size === 0) return false;
    const existing = functionTargetsBySymbol.get(symbol) ?? new Set();
    const size = existing.size;
    for (const target of targets) existing.add(target);
    functionTargetsBySymbol.set(symbol, existing);
    return existing.size !== size;
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

  function functionTargetsForExpression(expression, seenSymbols = new Set()) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(checker, current);
      if (!symbol || seenSymbols.has(symbol)) return new Set();
      const targets = functionTargetsForSymbol(symbol);
      for (const declaration of symbol.declarations ?? []) {
        for (const functionLike of functionLikesFromDeclaration(declaration))
          targets.add(functionLike);
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          !ts.isArrowFunction(declaration.initializer) &&
          !ts.isFunctionExpression(declaration.initializer)
        ) {
          for (const functionLike of functionTargetsForExpression(
            declaration.initializer,
            new Set([...seenSymbols, symbol]),
          )) {
            targets.add(functionLike);
          }
        }
      }
      return targets;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const targets = functionTargetsForSymbol(symbolForValue(current));
      const memberNames = accessMemberNames(current);
      const memberTargets = memberSetMapForSymbol(
        functionMembersBySymbol,
        symbolForValue(current.expression),
      );
      const selected = memberNames ?? new Set(memberTargets.keys());
      for (const memberName of selected) {
        for (const target of memberTargets.get(memberName) ?? []) targets.add(target);
      }
      for (const target of memberTargets.get('*') ?? []) targets.add(target);
      return targets;
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return functionTargetsForExpression(current.right, seenSymbols);
      }
      if (isLogicalOperator(current.operatorToken.kind)) {
        return union(
          ...logicalOperands(current).map((operand) =>
            functionTargetsForExpression(operand, seenSymbols),
          ),
        );
      }
    }
    if (ts.isConditionalExpression(current)) {
      return union(
        functionTargetsForExpression(current.whenTrue, seenSymbols),
        functionTargetsForExpression(current.whenFalse, seenSymbols),
      );
    }
    if (ts.isCallExpression(current) && isBindCall(current)) {
      return functionTargetsForExpression(bindOwner(current), seenSymbols);
    }
    return new Set();
  }

  function calledFunctionLikes(callExpression) {
    return [...functionTargetsForExpression(callExpression.expression)];
  }

  function bindOwner(callExpression) {
    const callee = unwrapExpression(callExpression.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') {
      return callee.expression;
    }
    if (
      ts.isElementAccessExpression(callee) &&
      staticPropertyNames(callee.argumentExpression)?.has('bind')
    ) {
      return callee.expression;
    }
    return undefined;
  }

  function isBindCall(callExpression) {
    return !!bindOwner(callExpression);
  }

  function knownArrayIdentities(values = []) {
    return { kind: 'known', values: new Set(values) };
  }

  function unknownArrayIdentities() {
    return { kind: 'unknown' };
  }

  function unknownCallableValue(value = {}) {
    return {
      ...emptyCallableValue(),
      ...value,
      arrayIdentities: unknownArrayIdentities(),
      arrayLike: true,
      nullish: MAY_BE_NULLISH | MAY_BE_NON_NULLISH,
      truthiness: MAY_BE_TRUTHY | MAY_BE_FALSY,
    };
  }

  function cloneArrayIdentities(identities) {
    return identities?.kind === 'known'
      ? knownArrayIdentities(identities.values)
      : unknownArrayIdentities();
  }

  function mergeArrayIdentities(values) {
    const identities = values.map((value) => value.arrayIdentities);
    if (identities.some((value) => !value || value.kind === 'unknown')) {
      return unknownArrayIdentities();
    }
    return knownArrayIdentities(union(...identities.map((value) => value.values)));
  }

  function typeMayBeArray(node) {
    if (!node || typeof node.kind !== 'number') return false;
    try {
      const type = checker.getTypeAtLocation(node);
      if (type.isUnion?.()) return type.types.some((member) => typeMayBeArrayType(member));
      return typeMayBeArrayType(type);
    } catch {
      return false;
    }
  }

  function typeMayBeArrayType(type) {
    return checker.isArrayType(type) || checker.isTupleType(type);
  }

  function normalizeAbstractValue(value, expression) {
    const normalized = value ?? {};
    if (!normalized.arrayIdentities) {
      const current = expression ? unwrapExpression(expression) : undefined;
      if (current && ts.isArrayLiteralExpression(current)) {
        normalized.arrayIdentities = knownArrayIdentities([current]);
      } else if (normalized.arrayLike || typeMayBeArray(current)) {
        normalized.arrayIdentities = unknownArrayIdentities();
      } else {
        normalized.arrayIdentities = knownArrayIdentities();
      }
    }
    normalized.accessors ??= [];
    normalized.arrayLike =
      normalized.arrayLike === true ||
      normalized.arrayIdentities.kind === 'unknown' ||
      normalized.arrayIdentities.values.size > 0;
    return normalized;
  }

  function withArrayIdentities(value, identities, expression) {
    const normalized = normalizeAbstractValue(value, expression);
    const definitelyArray = identities.kind === 'known' && identities.values.size > 0;
    return {
      ...normalized,
      arrayIdentities: cloneArrayIdentities(identities),
      arrayLike:
        identities.kind === 'unknown' ||
        (identities.kind === 'known' && identities.values.size > 0),
      nullish: definitelyArray ? MAY_BE_NON_NULLISH : normalized.nullish,
      truthiness: definitelyArray ? MAY_BE_TRUTHY : normalized.truthiness,
    };
  }

  function emptyCallableValue() {
    return {
      accessors: [],
      arrayIdentities: knownArrayIdentities(),
      arrayLike: false,
      constructors: [],
      functions: [],
      knownDefinedMembers: new Set(),
      kinds: 0,
      members: new Map(),
      nullish: MAY_BE_NULLISH | MAY_BE_NON_NULLISH,
      references: new Set(),
      runtimeInstance: false,
      strings: undefined,
      truthiness: MAY_BE_TRUTHY | MAY_BE_FALSY,
    };
  }

  function callableValueHasData(value) {
    return (
      value.arrayLike ||
      (value.accessors?.length ?? 0) > 0 ||
      value.kinds !== 0 ||
      value.functions.length > 0 ||
      (value.constructors?.length ?? 0) > 0 ||
      (value.knownDefinedMembers?.size ?? 0) > 0 ||
      value.members.size > 0 ||
      (value.references?.size ?? 0) > 0 ||
      value.strings !== undefined
    );
  }

  function mergeCallableValues(...candidates) {
    const values = candidates
      .filter(Boolean)
      .map((value) => normalizeAbstractValue(value))
      .filter((value) => callableValueHasData(value));
    if (values.length === 0) return emptyCallableValue();
    if (values.length === 1 && values[0].runtimeInstance) return values[0];
    const merged = emptyCallableValue();
    merged.arrayIdentities = mergeArrayIdentities(values);
    merged.kinds = values.reduce((kinds, value) => kinds | value.kinds, 0);
    merged.arrayLike = values.some((value) => value.arrayLike);
    merged.knownDefinedMembers = union(
      ...values.map((value) => value.knownDefinedMembers ?? new Set()),
    );
    merged.truthiness = values.reduce(
      (facts, value) => facts | (value.truthiness ?? MAY_BE_TRUTHY | MAY_BE_FALSY),
      0,
    );
    merged.nullish = values.reduce(
      (facts, value) => facts | (value.nullish ?? MAY_BE_NULLISH | MAY_BE_NON_NULLISH),
      0,
    );
    merged.references = union(...values.map((value) => value.references ?? new Set()));
    merged.runtimeInstance = values.some((value) => value.runtimeInstance);
    if (values.every((value) => value.strings !== undefined)) {
      merged.strings = union(...values.map((value) => value.strings));
    }
    for (const value of values) {
      for (const record of value.accessors) {
        if (
          !merged.accessors.some(
            (existing) =>
              existing.functionLike === record.functionLike &&
              existing.environment === record.environment &&
              existing.thisValue === record.thisValue,
          )
        ) {
          merged.accessors.push(record);
        }
      }
      for (const record of value.functions) {
        if (
          !merged.functions.some(
            (existing) =>
              existing.functionLike === record.functionLike &&
              existing.environment === record.environment &&
              existing.thisValue === record.thisValue,
          )
        ) {
          merged.functions.push(record);
        }
      }
      for (const record of value.constructors ?? []) {
        if (
          !merged.constructors.some(
            (existing) =>
              existing.classLike === record.classLike &&
              existing.environment === record.environment,
          )
        ) {
          merged.constructors.push(record);
        }
      }
      for (const [memberName, memberValue] of value.members) {
        merged.members.set(
          memberName,
          mergeCallableValues(merged.members.get(memberName), memberValue),
        );
      }
    }
    return merged;
  }

  function mergeCallableAlternatives(...values) {
    const merged = mergeCallableValues(...values);
    const candidates = values.filter(Boolean);
    merged.knownDefinedMembers = new Set(
      [...(candidates[0]?.knownDefinedMembers ?? [])].filter((memberName) =>
        candidates.every((value) => value.knownDefinedMembers?.has(memberName)),
      ),
    );
    if (values.length === 0 || values.some((value) => value.strings === undefined)) {
      merged.strings = undefined;
    }
    return merged;
  }

  function storedCallableValue(symbol) {
    if (!symbol) return emptyCallableValue();
    const target = aliasedSymbol(checker, symbol);
    const identity = target ?? symbol;
    const targets = functionTargetsForSymbol(symbol);
    const inheritedArrayIdentities = arrayIdentitiesForSymbol(identity);
    const value = {
      accessors: [],
      arrayIdentities:
        inheritedArrayIdentities.size > 0
          ? knownArrayIdentities(inheritedArrayIdentities)
          : typeMayBeArray(identity.valueDeclaration ?? identity.declarations?.[0])
            ? unknownArrayIdentities()
            : knownArrayIdentities(),
      arrayLike:
        inheritedArrayIdentities.size > 0 ||
        typeMayBeArray(identity.valueDeclaration ?? identity.declarations?.[0]),
      functions: [...targets].map((functionLike) => ({
        environment: undefined,
        functionLike,
      })),
      kinds: callableKindsForSymbol(symbol),
      members: new Map(),
      references: containerSymbols.has(identity)
        ? union(new Set([identity]), arrayIdentitiesForSymbol(identity))
        : new Set(),
      strings: undefined,
    };
    const memberKinds = memberMapForSymbol(callableMembersBySymbol, symbol);
    const memberFunctions = memberSetMapForSymbol(functionMembersBySymbol, symbol);
    const memberReferences = memberSetMapForSymbol(memberReferencesBySymbol, symbol);
    for (const memberName of union(
      new Set(memberKinds.keys()),
      new Set(memberFunctions.keys()),
      new Set(memberReferences.keys()),
    )) {
      value.members.set(memberName, {
        functions: [...(memberFunctions.get(memberName) ?? [])].map((functionLike) => ({
          environment: undefined,
          functionLike,
        })),
        kinds: memberKinds.get(memberName) ?? 0,
        members: new Map(),
        references: new Set(memberReferences.get(memberName) ?? []),
        strings: undefined,
      });
    }
    for (const declaration of union(
      new Set(symbol.declarations ?? []),
      new Set(target?.declarations ?? []),
    )) {
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
        value.constructors = [
          ...(value.constructors ?? []),
          { classLike: declaration, environment: undefined },
        ];
      }
    }
    return value;
  }

  function capturedEnvironment(environment) {
    return environment.size > 0 ? new Map(environment) : undefined;
  }

  function selectCallableMembers(value, memberNames) {
    const referencedValues = [];
    for (const reference of value.references ?? []) {
      const memberKinds = memberMapForSymbol(callableMembersBySymbol, reference);
      const memberFunctions = memberSetMapForSymbol(functionMembersBySymbol, reference);
      const memberReferences = memberSetMapForSymbol(memberReferencesBySymbol, reference);
      const selectedNames = memberNames
        ? union(memberNames, new Set(['*']))
        : union(
            new Set(memberKinds.keys()),
            new Set(memberFunctions.keys()),
            new Set(memberReferences.keys()),
          );
      for (const memberName of selectedNames) {
        referencedValues.push({
          functions: [...(memberFunctions.get(memberName) ?? [])].map((functionLike) => ({
            environment: undefined,
            functionLike,
          })),
          kinds: memberKinds.get(memberName) ?? 0,
          members: new Map(),
          references: new Set(memberReferences.get(memberName) ?? []),
          strings: undefined,
        });
      }
    }
    if (!memberNames) {
      return mergeCallableValues(...value.members.values(), ...referencedValues);
    }
    return mergeCallableValues(
      value.members.get('*'),
      ...[...memberNames].map((memberName) => value.members.get(memberName)),
      ...referencedValues,
    );
  }

  function selectedMemberIsDefinitelyDefined(value, memberNames) {
    return (
      !!memberNames &&
      memberNames.size > 0 &&
      [...memberNames].every((memberName) => value.knownDefinedMembers?.has(memberName))
    );
  }

  function callableValueWithDefault(
    selected,
    ownerValue,
    memberNames,
    initializer,
    environment,
    state,
  ) {
    return selectedMemberIsDefinitelyDefined(ownerValue, memberNames)
      ? selected
      : mergeCallableAlternatives(selected, callableValue(initializer, environment, state));
  }

  function materializedMembers(value) {
    const members = new Map(value.members);
    for (const reference of value.references ?? []) {
      const memberKinds = memberMapForSymbol(callableMembersBySymbol, reference);
      const memberFunctions = memberSetMapForSymbol(functionMembersBySymbol, reference);
      const memberReferences = memberSetMapForSymbol(memberReferencesBySymbol, reference);
      for (const memberName of union(
        new Set(memberKinds.keys()),
        new Set(memberFunctions.keys()),
        new Set(memberReferences.keys()),
      )) {
        members.set(
          memberName,
          mergeCallableValues(members.get(memberName), {
            functions: [...(memberFunctions.get(memberName) ?? [])].map((functionLike) => ({
              environment: undefined,
              functionLike,
            })),
            kinds: memberKinds.get(memberName) ?? 0,
            members: new Map(),
            references: new Set(memberReferences.get(memberName) ?? []),
            strings: undefined,
          }),
        );
      }
    }
    return members;
  }

  function restCallableValue(value, pattern, restIndex) {
    const members = new Map();
    const knownDefinedMembers = new Set();
    const sourceMembers = materializedMembers(value);
    if (ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern)) {
      const consumed = new Set();
      const properties = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
      for (const property of properties.slice(0, restIndex)) {
        if (ts.isBindingElement(property)) {
          const names = property.propertyName
            ? declarationMemberNames(property.propertyName)
            : ts.isIdentifier(property.name)
              ? new Set([property.name.text])
              : undefined;
          for (const name of names ?? []) consumed.add(name);
        } else if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          for (const name of declarationMemberNames(property.name) ?? []) consumed.add(name);
        }
      }
      for (const [memberName, memberValue] of sourceMembers) {
        if (memberName === '*' || !consumed.has(memberName)) {
          members.set(memberName, memberValue);
          if (value.knownDefinedMembers?.has(memberName)) {
            knownDefinedMembers.add(memberName);
          }
        }
      }
    } else {
      for (const [memberName, memberValue] of sourceMembers) {
        const index = Number(memberName);
        if (Number.isInteger(index) && index >= restIndex) {
          const shiftedIndex = String(index - restIndex);
          members.set(shiftedIndex, memberValue);
          if (value.knownDefinedMembers?.has(memberName)) {
            knownDefinedMembers.add(shiftedIndex);
          }
        } else if (memberName === '*') {
          members.set(memberName, memberValue);
        }
      }
    }
    return {
      arrayLike: !ts.isObjectBindingPattern(pattern) && !ts.isObjectLiteralExpression(pattern),
      functions: [],
      knownDefinedMembers,
      kinds: 0,
      members,
      strings: undefined,
    };
  }

  function bindingElementValue(element, environment, state) {
    const pattern = element.parent;
    const owner = pattern.parent;
    let ownerValue = emptyCallableValue();
    if (ts.isVariableDeclaration(owner) && owner.initializer) {
      ownerValue = callableValue(owner.initializer, environment, state);
    } else if (ts.isParameter(owner)) {
      const parameterSymbol = ts.isIdentifier(owner.name)
        ? symbolAt(checker, owner.name)
        : undefined;
      ownerValue = environment.get(parameterSymbol) ?? emptyCallableValue();
    } else if (ts.isBindingElement(owner)) {
      ownerValue = bindingElementValue(owner, environment, state);
    }
    let memberNames;
    let selected;
    if (element.dotDotDotToken) {
      selected = restCallableValue(ownerValue, pattern, pattern.elements.indexOf(element));
    } else if (ts.isObjectBindingPattern(pattern)) {
      memberNames = element.propertyName
        ? declarationMemberNames(element.propertyName)
        : ts.isIdentifier(element.name)
          ? new Set([element.name.text])
          : undefined;
      selected = selectCallableMembers(ownerValue, memberNames);
    } else {
      memberNames = new Set([String(pattern.elements.indexOf(element))]);
      selected = selectCallableMembers(ownerValue, memberNames);
    }
    return element.initializer
      ? callableValueWithDefault(
          selected,
          ownerValue,
          memberNames,
          element.initializer,
          environment,
          state,
        )
      : selected;
  }

  function classCallableValue(classLike, environment, state) {
    const value = {
      constructors: [{ classLike, environment: capturedEnvironment(environment) }],
      functions: [],
      kinds: 0,
      members: new Map(),
      strings: undefined,
    };
    for (const member of classLike.members) {
      if (!hasModifier(member, ts.SyntaxKind.StaticKeyword) || !member.name) continue;
      let memberValue = emptyCallableValue();
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        memberValue = callableValue(member.initializer, environment, state);
      } else if (ts.isMethodDeclaration(member)) {
        memberValue = {
          functions: [
            {
              environment: capturedEnvironment(environment),
              functionLike: member,
              thisValue: value,
            },
          ],
          kinds: 0,
          members: new Map(),
          strings: undefined,
        };
      }
      for (const memberName of declarationMemberNames(member.name) ?? ['*']) {
        value.members.set(
          memberName,
          mergeCallableValues(value.members.get(memberName), memberValue),
        );
      }
    }
    return value;
  }

  function hasReadOnlyLiteralContainer(identity, declarations) {
    if (readOnlyLiteralContainerSymbols.has(identity)) {
      return readOnlyLiteralContainerSymbols.get(identity);
    }
    const hasLiteralDeclarations =
      declarations.length > 0 &&
      declarations.every(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          !!declaration.initializer &&
          (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0 &&
          (ts.isObjectLiteralExpression(unwrapExpression(declaration.initializer)) ||
            ts.isArrayLiteralExpression(unwrapExpression(declaration.initializer))),
      );
    if (!hasLiteralDeclarations) {
      readOnlyLiteralContainerSymbols.set(identity, false);
      return false;
    }
    const readOnly = declarations.every(
      (declaration) =>
        runtimeSymbolUsage(declaration.getSourceFile()).get(identity)?.readOnly !== false,
    );
    readOnlyLiteralContainerSymbols.set(identity, readOnly);
    return readOnly;
  }

  function callableValueForSymbol(symbol, environment, state) {
    if (!symbol) return emptyCallableValue();
    const target = aliasedSymbol(checker, symbol);
    const contextual = environment.get(symbol) ?? environment.get(target);
    if (contextual) return contextual;
    const identity = target ?? symbol;
    if (state.seenSymbols.has(identity)) return storedCallableValue(symbol);
    const nextState = {
      ...state,
      seenSymbols: new Set([...state.seenSymbols, identity]),
    };
    const declarations = [
      ...union(new Set(symbol.declarations ?? []), new Set(target?.declarations ?? [])),
    ];
    const values =
      hasReadOnlyLiteralContainer(identity, declarations) ||
      declarations.some(
        (declaration) => ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration),
      )
        ? []
        : [storedCallableValue(symbol)];
    for (const declaration of declarations) {
      if (ts.isFunctionLike(declaration) && declaration.body) {
        values.push({
          functions: [{ environment: capturedEnvironment(environment), functionLike: declaration }],
          kinds: 0,
          members: new Map(),
          strings: undefined,
        });
      } else if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
        values.push(classCallableValue(declaration, environment, nextState));
      } else if (
        (ts.isVariableDeclaration(declaration) ||
          ts.isPropertyDeclaration(declaration) ||
          ts.isPropertyAssignment(declaration)) &&
        declaration.initializer
      ) {
        values.push(callableValue(declaration.initializer, environment, nextState));
      } else if (ts.isBindingElement(declaration)) {
        values.push(bindingElementValue(declaration, environment, nextState));
      }
    }
    for (const assignment of destructuringAssignmentsBySymbol.get(identity) ?? []) {
      values.push(
        assignmentValueForSymbol(
          assignment.pattern,
          identity,
          callableValue(assignment.expression, environment, nextState),
          environment,
          nextState,
        ),
      );
    }
    return mergeCallableValues(...values);
  }

  function bindCallablePattern(name, value, environment) {
    if (ts.isIdentifier(name)) {
      const symbol = symbolAt(checker, name);
      if (symbol) environment.set(symbol, value);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const [index, element] of name.elements.entries()) {
        const memberNames = element.propertyName
          ? declarationMemberNames(element.propertyName)
          : ts.isIdentifier(element.name)
            ? new Set([element.name.text])
            : undefined;
        const selected = element.dotDotDotToken
          ? restCallableValue(value, name, index)
          : selectCallableMembers(value, memberNames);
        bindCallablePattern(
          element.name,
          element.initializer
            ? callableValueWithDefault(
                selected,
                value,
                memberNames,
                element.initializer,
                environment,
              )
            : selected,
          environment,
        );
      }
      return;
    }
    name.elements.forEach((element, index) => {
      if (ts.isBindingElement(element)) {
        const selected = element.dotDotDotToken
          ? restCallableValue(value, name, index)
          : selectCallableMembers(value, new Set([String(index)]));
        bindCallablePattern(
          element.name,
          element.initializer
            ? callableValueWithDefault(
                selected,
                value,
                new Set([String(index)]),
                element.initializer,
                environment,
              )
            : selected,
          environment,
        );
      }
    });
  }

  function assignmentValueForSymbol(
    pattern,
    targetSymbol,
    value,
    environment,
    state,
    valueIsDefinitelyDefined = false,
  ) {
    const current = unwrapExpression(pattern);
    if (ts.isIdentifier(current)) {
      return symbolAt(checker, current) === targetSymbol ? value : emptyCallableValue();
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return assignmentValueForSymbol(
        current.left,
        targetSymbol,
        valueIsDefinitelyDefined
          ? value
          : mergeCallableAlternatives(value, callableValue(current.right, environment, state)),
        environment,
        state,
        valueIsDefinitelyDefined || isDefinitelyDefinedValue(current.right),
      );
    }
    const results = [];
    if (ts.isObjectLiteralExpression(current)) {
      for (const [index, property] of current.properties.entries()) {
        if (ts.isSpreadAssignment(property)) {
          results.push(
            assignmentValueForSymbol(
              property.expression,
              targetSymbol,
              restCallableValue(value, current, index),
              environment,
              state,
            ),
          );
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const memberNames = new Set([property.name.text]);
          results.push(
            assignmentValueForSymbol(
              property.name,
              targetSymbol,
              selectCallableMembers(value, memberNames),
              environment,
              state,
              selectedMemberIsDefinitelyDefined(value, memberNames),
            ),
          );
        } else if (ts.isPropertyAssignment(property)) {
          const memberNames = declarationMemberNames(property.name);
          results.push(
            assignmentValueForSymbol(
              property.initializer,
              targetSymbol,
              selectCallableMembers(value, memberNames),
              environment,
              state,
              selectedMemberIsDefinitelyDefined(value, memberNames),
            ),
          );
        }
      }
    } else if (ts.isArrayLiteralExpression(current)) {
      current.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        const selected = ts.isSpreadElement(element)
          ? restCallableValue(value, current, index)
          : selectCallableMembers(value, new Set([String(index)]));
        const memberNames = ts.isSpreadElement(element) ? undefined : new Set([String(index)]);
        results.push(
          assignmentValueForSymbol(
            ts.isSpreadElement(element) ? element.expression : element,
            targetSymbol,
            selected,
            environment,
            state,
            selectedMemberIsDefinitelyDefined(value, memberNames),
          ),
        );
      });
    }
    return mergeCallableValues(...results);
  }

  function collectAssignmentSymbols(pattern, symbols) {
    const current = unwrapExpression(pattern);
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(checker, current);
      if (symbol) symbols.add(symbol);
      return;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      collectAssignmentSymbols(current.left, symbols);
    } else if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          collectAssignmentSymbols(property.expression, symbols);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          collectAssignmentSymbols(property.name, symbols);
        } else if (ts.isPropertyAssignment(property)) {
          collectAssignmentSymbols(property.initializer, symbols);
        }
      }
    } else if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (!ts.isOmittedExpression(element)) {
          collectAssignmentSymbols(
            ts.isSpreadElement(element) ? element.expression : element,
            symbols,
          );
        }
      }
    }
  }

  function isDestructuringAssignmentDefault(expression) {
    let current = expression;
    while (current.parent) {
      const parent = current.parent;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return (
          parent.left === current || unwrapExpression(parent.left) === unwrapExpression(current)
        );
      }
      if (
        !ts.isParenthesizedExpression(parent) &&
        !ts.isObjectLiteralExpression(parent) &&
        !ts.isArrayLiteralExpression(parent) &&
        !ts.isPropertyAssignment(parent) &&
        !ts.isSpreadAssignment(parent) &&
        !ts.isSpreadElement(parent)
      ) {
        return false;
      }
      current = parent;
    }
    return false;
  }

  function isLogicalOperator(kind) {
    return (
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    );
  }

  function runtimePossibilities(
    expression,
    environment = new Map(),
    state,
    seenSymbols = new Set(),
  ) {
    const current = unwrapExpression(expression);
    if (current.kind === ts.SyntaxKind.NullKeyword) {
      return { nullish: MAY_BE_NULLISH, truthiness: MAY_BE_FALSY };
    }
    if (current.kind === ts.SyntaxKind.TrueKeyword) {
      return { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY };
    }
    if (current.kind === ts.SyntaxKind.FalseKeyword) {
      return { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_FALSY };
    }
    if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      return {
        nullish: MAY_BE_NON_NULLISH,
        truthiness: current.text.length === 0 ? MAY_BE_FALSY : MAY_BE_TRUTHY,
      };
    }
    if (ts.isNumericLiteral(current)) {
      return {
        nullish: MAY_BE_NON_NULLISH,
        truthiness: Number(current.text) === 0 ? MAY_BE_FALSY : MAY_BE_TRUTHY,
      };
    }
    if (
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isClassExpression(current) ||
      isModuleRequire(current)
    ) {
      return { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY };
    }
    if (ts.isIdentifier(current)) {
      if (current.text === 'undefined' && isUnshadowedIdentifier(current, 'undefined')) {
        return { nullish: MAY_BE_NULLISH, truthiness: MAY_BE_FALSY };
      }
      if (isUnshadowedIdentifier(current, 'require')) {
        return { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY };
      }
      const symbol = symbolAt(checker, current);
      const target = aliasedSymbol(checker, symbol);
      const contextual = environment.get(symbol) ?? environment.get(target);
      if (contextual) {
        return {
          nullish: contextual.nullish ?? MAY_BE_NULLISH | MAY_BE_NON_NULLISH,
          truthiness: contextual.truthiness ?? MAY_BE_TRUTHY | MAY_BE_FALSY,
        };
      }
      if (symbol && !seenSymbols.has(symbol)) {
        for (const declaration of symbol.declarations ?? []) {
          if (ts.isFunctionLike(declaration) || ts.isClassDeclaration(declaration)) {
            return { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY };
          }
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0
          ) {
            return runtimePossibilities(
              declaration.initializer,
              environment,
              state,
              new Set([...seenSymbols, symbol]),
            );
          }
        }
      }
      const value = state
        ? callableValueForSymbol(symbol, environment, state)
        : storedCallableValue(symbol);
      if (
        value.kinds !== 0 ||
        value.functions.length > 0 ||
        (value.constructors?.length ?? 0) > 0
      ) {
        return { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY };
      }
    }
    return {
      nullish: MAY_BE_NULLISH | MAY_BE_NON_NULLISH,
      truthiness: MAY_BE_TRUTHY | MAY_BE_FALSY,
    };
  }

  function logicalOperands(expression, environment = new Map(), state) {
    const possibilities = runtimePossibilities(expression.left, environment, state);
    const kind = expression.operatorToken.kind;
    const operands = [];
    const leftReachable =
      (kind === ts.SyntaxKind.BarBarToken && (possibilities.truthiness & MAY_BE_TRUTHY) !== 0) ||
      (kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        (possibilities.truthiness & MAY_BE_FALSY) !== 0) ||
      (kind === ts.SyntaxKind.QuestionQuestionToken &&
        (possibilities.nullish & MAY_BE_NON_NULLISH) !== 0);
    const rightReachable =
      (kind === ts.SyntaxKind.BarBarToken && (possibilities.truthiness & MAY_BE_FALSY) !== 0) ||
      (kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        (possibilities.truthiness & MAY_BE_TRUTHY) !== 0) ||
      (kind === ts.SyntaxKind.QuestionQuestionToken &&
        (possibilities.nullish & MAY_BE_NULLISH) !== 0);
    if (leftReachable) operands.push(expression.left);
    if (rightReachable) operands.push(expression.right);
    return operands;
  }

  function containsCallableKind(value, seen = new Set()) {
    if (seen.has(value)) return false;
    seen.add(value);
    return (
      value.kinds !== 0 ||
      value.functions.some(
        (record) => (callableReturnsByFunction.get(record.functionLike) ?? 0) !== 0,
      ) ||
      [...value.members.values()].some((memberValue) => containsCallableKind(memberValue, seen))
    );
  }

  function functionBodyCreatesInstance(functionLike) {
    if (functionBodiesCreatingInstance.has(functionLike)) {
      return functionBodiesCreatingInstance.get(functionLike);
    }
    let createsInstance = false;
    function visit(node) {
      if (createsInstance || (node !== functionLike && ts.isFunctionLike(node))) return;
      if (ts.isNewExpression(node)) {
        createsInstance = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(functionLike.body);
    functionBodiesCreatingInstance.set(functionLike, createsInstance);
    return createsInstance;
  }

  function symbolDeclaresRuntimeInstance(symbol, seenSymbols = new Set()) {
    const identity = aliasedSymbol(checker, symbol) ?? symbol;
    if (!identity || seenSymbols.has(identity)) return false;
    if (runtimeInstanceSymbols.has(identity)) return runtimeInstanceSymbols.get(identity);
    const nextSeenSymbols = new Set([...seenSymbols, identity]);
    const declaresInstance = [...(identity.declarations ?? [])].some((declaration) => {
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
      const initializer = unwrapExpression(declaration.initializer);
      return (
        ts.isNewExpression(initializer) ||
        (ts.isIdentifier(initializer) &&
          symbolDeclaresRuntimeInstance(symbolAt(checker, initializer), nextSeenSymbols))
      );
    });
    runtimeInstanceSymbols.set(identity, declaresInstance);
    return declaresInstance;
  }

  function callTargetsRuntimeInstance(callExpression, environment, state) {
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    const owner = unwrapExpression(callee.expression);
    if (owner.kind === ts.SyntaxKind.ThisKeyword) return !!state.thisValue?.runtimeInstance;
    if (!ts.isIdentifier(owner)) return false;
    const symbol = symbolAt(checker, owner);
    const target = aliasedSymbol(checker, symbol);
    const contextual = environment.get(symbol) ?? environment.get(target);
    return !!contextual?.runtimeInstance || symbolDeclaresRuntimeInstance(symbol);
  }

  function applyRuntimeAssignment(target, value, environment, state) {
    const current = unwrapExpression(target);
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(checker, current);
      if (symbol) environment.set(symbol, value);
      return;
    }
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      const symbols = new Set();
      collectAssignmentSymbols(current, symbols);
      for (const symbol of symbols) {
        environment.set(
          symbol,
          assignmentValueForSymbol(current, symbol, value, environment, state),
        );
      }
      return;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const owner = callableValue(current.expression, environment, state);
      for (const memberName of accessMemberNames(current) ?? ['*']) {
        owner.members.set(
          memberName,
          owner.runtimeInstance && !state.runtimeBranchAlternatives
            ? value
            : mergeCallableValues(owner.members.get(memberName), value),
        );
        if (owner.runtimeInstance && memberName !== '*') {
          owner.knownDefinedMembers.add(memberName);
        }
      }
    }
  }

  function isDeclaredThisAlias(expression, seenSymbols = new Set()) {
    const current = unwrapExpression(expression);
    if (current.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(current)) return false;
    const symbol = symbolAt(checker, current);
    const identity = aliasedSymbol(checker, symbol) ?? symbol;
    if (!identity || seenSymbols.has(identity)) return false;
    const nextSeenSymbols = new Set([...seenSymbols, identity]);
    return [...(identity.declarations ?? [])].some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        !!declaration.initializer &&
        isDeclaredThisAlias(declaration.initializer, nextSeenSymbols),
    );
  }

  function thisAliasValue(expression, environment, state) {
    if (!state.thisValue) return undefined;
    const current = unwrapExpression(expression);
    if (current.kind === ts.SyntaxKind.ThisKeyword) return state.thisValue;
    if (!ts.isIdentifier(current)) return undefined;
    const symbol = symbolAt(checker, current);
    const target = aliasedSymbol(checker, symbol);
    const contextual = environment.get(symbol) ?? environment.get(target);
    return contextual === state.thisValue ? state.thisValue : undefined;
  }

  function functionResult(record, argumentValues, state) {
    const functionLike = record.functionLike;
    if (state.callStack.has(functionLike)) return emptyCallableValue();
    const environment = new Map(record.environment ?? []);
    functionLike.parameters.forEach((parameter, index) => {
      let argumentValue;
      if (parameter.dotDotDotToken) {
        const members = new Map();
        argumentValues.slice(index).forEach((value, restIndex) => {
          members.set(String(restIndex), value);
        });
        argumentValue = { functions: [], kinds: 0, members, strings: undefined };
      } else {
        argumentValue = argumentValues[index] ?? emptyCallableValue();
      }
      if (!callableValueHasData(argumentValue) && parameter.initializer) {
        argumentValue = callableValue(parameter.initializer, environment, state);
      }
      bindCallablePattern(parameter.name, argumentValue, environment);
    });
    const nextState = {
      ...state,
      callStack: new Set([...state.callStack, functionLike]),
      seenSymbols: new Set(),
      thisValue: record.thisValue ?? state.thisValue,
    };
    if (ts.isArrowFunction(functionLike) && !ts.isBlock(functionLike.body)) {
      return callableValue(functionLike.body, environment, nextState);
    }
    if (!functionLike.body || !ts.isBlock(functionLike.body)) return emptyCallableValue();
    const returns = [];
    const inspectBodyCalls = [...environment.values()].some((value) => containsCallableKind(value));
    const inspectRuntimeInstanceCalls = functionBodyCreatesInstance(functionLike);
    function visit(node, visitState = nextState) {
      if (node !== functionLike && ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node)) {
        const conditionExpression = unwrapExpression(node.expression);
        const condition =
          ts.isCallExpression(conditionExpression) &&
          (inspectBodyCalls ||
            record.thisValue ||
            (inspectRuntimeInstanceCalls &&
              callTargetsRuntimeInstance(conditionExpression, environment, visitState)))
            ? callableValue(node.expression, environment, visitState)
            : undefined;
        const truthiness =
          condition?.truthiness ??
          runtimePossibilities(node.expression, environment, visitState).truthiness;
        const thenReachable = (truthiness & MAY_BE_TRUTHY) !== 0;
        const elseReachable = (truthiness & MAY_BE_FALSY) !== 0;
        const branchState =
          thenReachable && elseReachable
            ? { ...visitState, runtimeBranchAlternatives: true }
            : visitState;
        if (thenReachable) visit(node.thenStatement, branchState);
        if (elseReachable && node.elseStatement) visit(node.elseStatement, branchState);
        return;
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const alias = thisAliasValue(node.initializer, environment, visitState);
        if (alias) bindCallablePattern(node.name, alias, environment);
      }
      if (ts.isReturnStatement(node) && node.expression) {
        returns.push(callableValue(node.expression, environment, visitState));
        return;
      }
      if (
        (inspectBodyCalls || record.thisValue) &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        applyRuntimeAssignment(
          node.left,
          callableValue(node.right, environment, visitState),
          environment,
          visitState,
        );
      }
      if (
        ts.isCallExpression(node) &&
        (inspectBodyCalls ||
          record.thisValue ||
          (inspectRuntimeInstanceCalls &&
            callTargetsRuntimeInstance(node, environment, visitState)))
      ) {
        callableValue(node, environment, visitState);
      }
      ts.forEachChild(node, (child) => visit(child, visitState));
    }
    visit(functionLike.body);
    return mergeCallableAlternatives(...returns);
  }

  function classInstance(record, argumentValues, state) {
    const instance = emptyCallableValue();
    instance.nullish = MAY_BE_NON_NULLISH;
    instance.runtimeInstance = true;
    instance.truthiness = MAY_BE_TRUTHY;
    const environment = new Map(record.environment ?? []);
    const classLike = record.classLike;
    for (const member of classLike.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        member.name &&
        member.initializer
      ) {
        const memberValue = callableValue(member.initializer, environment, {
          ...state,
          thisValue: instance,
        });
        for (const memberName of declarationMemberNames(member.name) ?? ['*']) {
          instance.members.set(
            memberName,
            mergeCallableValues(instance.members.get(memberName), memberValue),
          );
          if (memberName !== '*') instance.knownDefinedMembers.add(memberName);
        }
      } else if (
        ts.isMethodDeclaration(member) &&
        !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        member.name
      ) {
        const methodValue = {
          functions: [
            {
              environment: capturedEnvironment(environment),
              functionLike: member,
              thisValue: instance,
            },
          ],
          kinds: 0,
          members: new Map(),
          strings: undefined,
        };
        for (const memberName of declarationMemberNames(member.name) ?? ['*']) {
          instance.members.set(
            memberName,
            mergeCallableValues(instance.members.get(memberName), methodValue),
          );
          if (memberName !== '*') instance.knownDefinedMembers.add(memberName);
        }
      }
    }
    const constructor = classLike.members.find((member) => ts.isConstructorDeclaration(member));
    if (constructor && ts.isConstructorDeclaration(constructor)) {
      constructor.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name) || !parameter.modifiers?.length) return;
        instance.members.set(
          parameter.name.text,
          mergeCallableValues(
            instance.members.get(parameter.name.text),
            argumentValues[index] ?? emptyCallableValue(),
          ),
        );
        instance.knownDefinedMembers.add(parameter.name.text);
      });
      functionResult(
        {
          environment: capturedEnvironment(environment),
          functionLike: constructor,
          thisValue: instance,
        },
        argumentValues,
        state,
      );
    }
    return instance;
  }

  function arrayEntries(value) {
    return [...materializedMembers(value)]
      .filter(([memberName]) => Number.isInteger(Number(memberName)))
      .sort(([left], [right]) => Number(left) - Number(right));
  }

  function arrayElements(value) {
    return arrayEntries(value).map(([, memberValue]) => memberValue);
  }

  function invokeFunctions(value, argumentValues, state) {
    return mergeCallableAlternatives(
      ...value.functions.map((record) => functionResult(record, argumentValues, state)),
    );
  }

  function stateForInvocation(state, expression) {
    return {
      ...state,
      runtimeInvocationPath: [...(state.runtimeInvocationPath ?? []), expression],
    };
  }

  function stateForCallbackInvocation(state, expression, index) {
    return {
      ...state,
      runtimeInvocationPath: [...(state.runtimeInvocationPath ?? []), expression, index],
    };
  }

  function arrayMutationForCall(callExpression) {
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return undefined;
    }
    const memberNames = accessMemberNames(callee);
    if (!memberNames || memberNames.size !== 1) return undefined;
    const methodName = [...memberNames][0];
    return methodName === 'push' || methodName === 'unshift'
      ? { methodName, owner: callee.expression }
      : undefined;
  }

  function straightLineObjectAssignExpressionKinds(expression, kindsBySymbol) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      if (isUnshadowedIdentifier(current, 'undefined')) return 0;
      const identity = valueSymbolIdentity(current);
      if (identity && kindsBySymbol.has(identity)) return kindsBySymbol.get(identity);
      return (symbolAt(checker, current)?.declarations ?? []).some((declaration) =>
        ts.isFunctionLike(declaration),
      )
        ? 0
        : undefined;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const memberNames = accessMemberNames(current);
      const owner = unwrapExpression(current.expression);
      return memberNames?.size === 1 &&
        memberNames.has('assign') &&
        ts.isIdentifier(owner) &&
        isUnshadowedIdentifier(owner, 'Object')
        ? CALLABLE_OBJECT_ASSIGN
        : ts.isIdentifier(owner) && isUnshadowedIdentifier(owner, 'console')
          ? 0
          : undefined;
    }
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isClassExpression(current) ||
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isStringLiteralLike(current) ||
      ts.isNumericLiteral(current) ||
      current.kind === ts.SyntaxKind.NullKeyword ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return 0;
    }
    if (ts.isConditionalExpression(current)) {
      const whenTrue = straightLineObjectAssignExpressionKinds(current.whenTrue, kindsBySymbol);
      const whenFalse = straightLineObjectAssignExpressionKinds(current.whenFalse, kindsBySymbol);
      return whenTrue === undefined || whenFalse === undefined ? undefined : whenTrue | whenFalse;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return straightLineObjectAssignExpressionKinds(current.right, kindsBySymbol);
    }
    return undefined;
  }

  function straightLineObjectAssignMemberKinds(expression, memberNames, kindsBySymbol) {
    if (!memberNames || memberNames.size === 0) return undefined;
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current) && isUnshadowedIdentifier(current, 'Object')) {
      return {
        definitelyDefined: memberNames.size === 1 && memberNames.has('assign'),
        kinds: memberNames.has('assign') ? CALLABLE_OBJECT_ASSIGN : 0,
      };
    }
    if (!ts.isObjectLiteralExpression(current)) return undefined;

    let kinds = 0;
    let definitelyDefined = true;
    for (const memberName of memberNames) {
      let memberKinds = 0;
      let memberIsDefinitelyDefined = false;
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) return undefined;
        const propertyNames = declarationMemberNames(property.name);
        if (!propertyNames?.has(memberName)) continue;
        if (ts.isPropertyAssignment(property)) {
          const valueKinds = straightLineObjectAssignExpressionKinds(
            property.initializer,
            kindsBySymbol,
          );
          if (valueKinds === undefined) return undefined;
          memberKinds = valueKinds;
          memberIsDefinitelyDefined = isDefinitelyDefinedValue(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const valueKinds = straightLineObjectAssignExpressionKinds(property.name, kindsBySymbol);
          if (valueKinds === undefined) return undefined;
          memberKinds = valueKinds;
          memberIsDefinitelyDefined = isDefinitelyDefinedValue(property.name);
        } else {
          memberKinds = 0;
          memberIsDefinitelyDefined = true;
        }
      }
      kinds |= memberKinds;
      definitelyDefined &&= memberIsDefinitelyDefined;
    }
    return { definitelyDefined, kinds };
  }

  function assignStraightLineObjectPattern(pattern, expression, kindsBySymbol) {
    const current = unwrapExpression(pattern);
    const properties = ts.isObjectBindingPattern(current)
      ? current.elements
      : ts.isObjectLiteralExpression(current)
        ? current.properties
        : undefined;
    if (!properties) return false;

    for (const property of properties) {
      let memberNames;
      let target;
      let defaultValue;
      if (ts.isBindingElement(property) && !property.dotDotDotToken) {
        memberNames = property.propertyName
          ? declarationMemberNames(property.propertyName)
          : ts.isIdentifier(property.name)
            ? new Set([property.name.text])
            : undefined;
        target = property.name;
        defaultValue = property.initializer;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        memberNames = new Set([property.name.text]);
        target = property.name;
        defaultValue = property.objectAssignmentInitializer;
      } else if (ts.isPropertyAssignment(property)) {
        memberNames = declarationMemberNames(property.name);
        target = unwrapExpression(property.initializer);
        if (
          ts.isBinaryExpression(target) &&
          target.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          defaultValue = target.right;
          target = unwrapExpression(target.left);
        }
      } else {
        return false;
      }
      if (!ts.isIdentifier(target)) return false;
      const selected = straightLineObjectAssignMemberKinds(expression, memberNames, kindsBySymbol);
      if (!selected) return false;
      let kinds = selected.kinds;
      if (defaultValue && !selected.definitelyDefined) {
        const defaultKinds = straightLineObjectAssignExpressionKinds(defaultValue, kindsBySymbol);
        if (defaultKinds === undefined) return false;
        kinds |= defaultKinds;
      }
      const identity = ts.isShorthandPropertyAssignment(property)
        ? checker.getShorthandAssignmentValueSymbol(property)
        : valueSymbolIdentity(target);
      if (!identity) return false;
      kindsBySymbol.set(identity, kinds);
    }
    return true;
  }

  function straightLineObjectAssignCallKinds(callExpression) {
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isIdentifier(callee)) return undefined;
    const callStatement = containingSourceFileStatement(callExpression);
    if (!callStatement) return undefined;

    const kindsBySymbol = new Map();
    for (const statement of callExpression.getSourceFile().statements) {
      if (statement === callStatement) break;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const identity = valueSymbolIdentity(declaration.name);
            const kinds = declaration.initializer
              ? straightLineObjectAssignExpressionKinds(declaration.initializer, kindsBySymbol)
              : 0;
            if (!identity || kinds === undefined) return undefined;
            kindsBySymbol.set(identity, kinds);
          } else if (
            !declaration.initializer ||
            !assignStraightLineObjectPattern(
              declaration.name,
              declaration.initializer,
              kindsBySymbol,
            )
          ) {
            return undefined;
          }
        }
        continue;
      }
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrapExpression(statement.expression);
        if (
          ts.isBinaryExpression(expression) &&
          expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const target = unwrapExpression(expression.left);
          if (ts.isIdentifier(target)) {
            const identity = valueSymbolIdentity(target);
            const kinds = straightLineObjectAssignExpressionKinds(expression.right, kindsBySymbol);
            if (!identity || kinds === undefined) return undefined;
            kindsBySymbol.set(identity, kinds);
            continue;
          }
          if (
            ts.isObjectLiteralExpression(target) &&
            assignStraightLineObjectPattern(target, expression.right, kindsBySymbol)
          ) {
            continue;
          }
        }
        if (ts.isStringLiteralLike(expression)) continue;
        if (ts.isCallExpression(expression)) continue;
        return undefined;
      }
      if (
        !ts.isExportDeclaration(statement) &&
        !ts.isImportDeclaration(statement) &&
        !ts.isImportEqualsDeclaration(statement) &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isClassDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isEmptyStatement(statement)
      ) {
        return undefined;
      }
    }

    const identity = valueSymbolIdentity(callee);
    return identity && kindsBySymbol.has(identity) ? kindsBySymbol.get(identity) : undefined;
  }

  function isObjectAssignCall(callExpression) {
    const straightLineKinds = straightLineObjectAssignCallKinds(callExpression);
    return (
      ((straightLineKinds ?? callableKinds(callExpression.expression)) & CALLABLE_OBJECT_ASSIGN) !==
      0
    );
  }

  function containingTopLevelStatement(node) {
    let current = node;
    while (current && !ts.isSourceFile(current.parent)) {
      if (ts.isFunctionLike(current) || ts.isBlock(current)) return undefined;
      current = current.parent;
    }
    return current && ts.isStatement(current) ? current : undefined;
  }

  function exactLiteralContainerState(expression) {
    const current = unwrapExpression(expression);
    if (ts.isArrayLiteralExpression(current)) {
      if (current.elements.some((element) => ts.isSpreadElement(element))) return undefined;
      return {
        elements: current.elements.map((element) =>
          ts.isOmittedExpression(element) ? undefined : element,
        ),
        kind: 'array',
      };
    }
    if (!ts.isObjectLiteralExpression(current)) return undefined;
    const state = { kind: 'object', members: new Map() };
    if (!applyExactObjectSources(state, [current])) return undefined;
    return state;
  }

  function applyExactObjectSources(state, sources) {
    for (const source of sources) {
      const current = unwrapExpression(source);
      if (!ts.isObjectLiteralExpression(current)) return false;
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          return false;
        }
        const memberNames = declarationMemberNames(property.name);
        if (!memberNames || memberNames.size !== 1) return false;
        const valueExpression = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property;
        for (const memberName of memberNames) {
          if (state.kind === 'array') {
            const index = exactArrayIndex(memberName);
            if (index === undefined) return false;
            state.elements[index] = valueExpression;
          } else {
            state.members.set(memberName, valueExpression);
          }
        }
      }
    }
    return true;
  }

  function applyObjectAssignSources(state, sources) {
    state.exactMembersAfterUnknownSource ??= new Set();
    for (const source of sources) {
      const current = unwrapExpression(source);
      if (!ts.isObjectLiteralExpression(current)) {
        state.hasUnknownSource = true;
        state.exactMembersAfterUnknownSource.clear();
        continue;
      }
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          state.hasUnknownSource = true;
          state.exactMembersAfterUnknownSource.clear();
          continue;
        }
        const memberNames = declarationMemberNames(property.name);
        if (!memberNames || memberNames.size !== 1) {
          state.hasUnknownSource = true;
          state.exactMembersAfterUnknownSource.clear();
          continue;
        }
        const valueExpression = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property;
        for (const memberName of memberNames) {
          if (state.kind === 'array') {
            const index = exactArrayIndex(memberName);
            if (index === undefined) {
              state.hasUnknownSource = true;
              state.exactMembersAfterUnknownSource.clear();
              continue;
            }
            state.elements[index] = valueExpression;
          } else {
            state.members.set(memberName, valueExpression);
          }
          if (state.hasUnknownSource) {
            state.exactMembersAfterUnknownSource.add(memberName);
          }
        }
      }
    }
  }

  function valueSymbolIdentity(expression) {
    const current = unwrapExpression(expression);
    if (!ts.isIdentifier(current)) return undefined;
    const symbol = symbolAt(checker, current);
    return aliasedSymbol(checker, symbol) ?? symbol;
  }

  function sameValueSymbol(expression, expectedSymbol) {
    return valueSymbolIdentity(expression) === expectedSymbol;
  }

  function exactTopLevelSpreadValue(expression, environment, runtimeState) {
    if (!collectLoaderContexts || !ts.isIdentifier(expression)) return undefined;
    const parent = expression.parent;
    if (!ts.isSpreadAssignment(parent) || parent.expression !== expression) return undefined;
    const identity = valueSymbolIdentity(expression);
    const spreadStatement = containingTopLevelStatement(expression);
    if (!identity || !spreadStatement) return undefined;
    if (hasReadOnlyLiteralContainer(identity, [...(identity.declarations ?? [])])) {
      return undefined;
    }

    const trackedSymbols = new Set([identity]);
    const isTrackedValue = (candidate) => {
      const candidateIdentity = valueSymbolIdentity(candidate);
      return !!candidateIdentity && trackedSymbols.has(candidateIdentity);
    };
    const referencesTrackedValue = (node) => {
      let found = false;
      function visit(current) {
        if (found) return;
        if (ts.isIdentifier(current) && isTrackedValue(current)) {
          found = true;
          return;
        }
        ts.forEachChild(current, visit);
      }
      visit(node);
      return found;
    };
    const onlySnapshotsTrackedValue = (node) => {
      let found = false;
      let snapshotsOnly = true;
      function visit(current) {
        if (!snapshotsOnly) return;
        if (ts.isIdentifier(current) && isTrackedValue(current)) {
          found = true;
          snapshotsOnly =
            ts.isSpreadAssignment(current.parent) && current.parent.expression === current;
          return;
        }
        ts.forEachChild(current, visit);
      }
      visit(node);
      return found && snapshotsOnly;
    };
    let containerState;

    for (const statement of expression.getSourceFile().statements) {
      if (statement === spreadStatement) break;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            if (declaration.initializer && referencesTrackedValue(declaration.initializer)) {
              return undefined;
            }
            continue;
          }
          const declarationIdentity = valueSymbolIdentity(declaration.name);
          if (declarationIdentity === identity) {
            containerState = declaration.initializer
              ? exactLiteralContainerState(declaration.initializer)
              : undefined;
            trackedSymbols.clear();
            trackedSymbols.add(identity);
          } else if (declarationIdentity && declaration.initializer) {
            if (isTrackedValue(declaration.initializer)) {
              trackedSymbols.add(declarationIdentity);
            } else {
              trackedSymbols.delete(declarationIdentity);
              if (
                referencesTrackedValue(declaration.initializer) &&
                !onlySnapshotsTrackedValue(declaration.initializer)
              ) {
                return undefined;
              }
            }
          }
        }
        continue;
      }
      if (!ts.isExpressionStatement(statement)) {
        if (referencesTrackedValue(statement)) return undefined;
        continue;
      }
      const current = unwrapExpression(statement.expression);
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrapExpression(current.left);
        if (
          (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
          isTrackedValue(left.expression)
        ) {
          const memberNames = accessMemberNames(left);
          if (!containerState || !memberNames || memberNames.size !== 1) return undefined;
          const memberName = [...memberNames][0];
          if (containerState.kind === 'array') {
            const index = exactArrayIndex(memberName);
            if (index === undefined) return undefined;
            containerState.elements[index] = current.right;
          } else {
            containerState.members.set(memberName, current.right);
          }
          continue;
        }
        const assignmentIdentity = valueSymbolIdentity(left);
        if (assignmentIdentity) {
          const assignsTrackedValue = isTrackedValue(current.right);
          if (assignmentIdentity === identity && !assignsTrackedValue) {
            containerState = exactLiteralContainerState(current.right);
            trackedSymbols.clear();
            trackedSymbols.add(identity);
          } else if (assignmentIdentity !== identity) {
            if (assignsTrackedValue) trackedSymbols.add(assignmentIdentity);
            else trackedSymbols.delete(assignmentIdentity);
          }
          continue;
        }
        if (assignmentIncludesTrackedSymbol(left, trackedSymbols)) return undefined;
      }
      const arrayMutation = ts.isCallExpression(current)
        ? arrayMutationForCall(current)
        : undefined;
      if (arrayMutation && isTrackedValue(arrayMutation.owner)) {
        if (containerState?.kind !== 'array') return undefined;
        if (arrayMutation.methodName === 'push') {
          containerState.elements.push(...current.arguments);
        } else {
          containerState.elements.unshift(...current.arguments);
        }
        continue;
      }
      if (
        ts.isCallExpression(current) &&
        isObjectAssignCall(current) &&
        current.arguments[0] &&
        isTrackedValue(current.arguments[0])
      ) {
        if (!containerState) return undefined;
        applyObjectAssignSources(containerState, current.arguments.slice(1));
        if (containerState.hasUnknownSource) return undefined;
        continue;
      }
      if (referencesTrackedValue(current)) return undefined;
    }
    if (!containerState) return undefined;

    const members = new Map();
    const knownDefinedMembers = new Set();
    const knownPresentMembers = new Set();
    const nextState = {
      ...runtimeState,
      seenSymbols: new Set([...runtimeState.seenSymbols, identity]),
    };
    const entries =
      containerState.kind === 'array'
        ? containerState.elements.map((value, index) => [String(index), value])
        : [...containerState.members];
    for (const [memberName, valueExpression] of entries) {
      if (!valueExpression) continue;
      members.set(memberName, callableValue(valueExpression, environment, nextState));
      knownPresentMembers.add(memberName);
      if (isDefinitelyDefinedValue(valueExpression)) knownDefinedMembers.add(memberName);
    }
    return {
      arrayLike: containerState.kind === 'array',
      functions: [],
      knownDefinedMembers,
      knownPresentMembers,
      kinds: 0,
      members,
      strings: undefined,
    };
  }

  function exactArrayIndex(memberName) {
    const index = Number(memberName);
    return Number.isInteger(index) &&
      index >= 0 &&
      index < 2 ** 32 - 1 &&
      String(index) === memberName
      ? index
      : undefined;
  }

  function assignmentIncludesTrackedSymbol(pattern, trackedSymbols) {
    const symbols = new Set();
    collectAssignmentSymbols(pattern, symbols);
    return [...symbols].some((symbol) =>
      trackedSymbols.has(aliasedSymbol(checker, symbol) ?? symbol),
    );
  }

  function exactTopLevelContainerMemberValue(access, memberNames) {
    if (!collectLoaderContexts || !memberNames || memberNames.size !== 1) return undefined;
    const owner = unwrapExpression(access.expression);
    if (!ts.isIdentifier(owner)) return undefined;
    const symbol = symbolAt(checker, owner);
    const identity = aliasedSymbol(checker, symbol) ?? symbol;
    if (!identity) return undefined;
    if (
      arrayIdentitiesForSymbol(identity).size === 0 &&
      !containerSymbols.has(identity) &&
      !typeMayBeArray(owner)
    ) {
      return undefined;
    }
    const value = sourceOrderedArrayMutationValue(access, owner);
    if (value.arrayIdentities.kind === 'unknown') return undefined;
    if ([...memberNames].every((memberName) => value.knownDefinedMembers.has(memberName))) {
      const members = [...memberNames].map((memberName) => value.members.get(memberName));
      return members.length === 1 ? members[0] : mergeCallableAlternatives(...members);
    }
    return selectCallableMembers(value, memberNames);
  }

  function assignObjectMembers(target, sources) {
    for (const source of sources) {
      for (const [memberName, memberValue] of materializedMembers(source)) {
        target.members.set(
          memberName,
          mergeCallableValues(target.members.get(memberName), memberValue),
        );
      }
    }
    return target;
  }

  function callbackPipelineResult(callExpression, environment, state) {
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return undefined;
    }
    const memberNames = accessMemberNames(callee);
    if (!memberNames || memberNames.size !== 1) return undefined;
    const methodName = [...memberNames][0];
    if (
      !['map', 'flatMap', 'filter', 'find', 'some', 'every', 'forEach', 'reduce'].includes(
        methodName,
      )
    ) {
      return undefined;
    }
    const owner = callableValue(callee.expression, environment, state);
    if (!owner.arrayLike) return undefined;
    const elements = arrayElements(owner);
    const callback = callExpression.arguments[0]
      ? callableValue(callExpression.arguments[0], environment, state)
      : emptyCallableValue();
    const initialValue =
      methodName === 'reduce' && callExpression.arguments.length > 1
        ? callableValue(callExpression.arguments[1], environment, state)
        : undefined;
    if (
      !containsCallableKind(owner) &&
      !containsCallableKind(callback) &&
      !(initialValue && containsCallableKind(initialValue))
    ) {
      return undefined;
    }
    if (methodName === 'filter') return owner;
    if (methodName === 'find') return mergeCallableAlternatives(...elements);
    if (methodName === 'map' || methodName === 'flatMap') {
      const members = new Map();
      let resultIndex = 0;
      elements.forEach((element, index) => {
        const callbackResult = invokeFunctions(
          callback,
          [
            element,
            {
              functions: [],
              kinds: 0,
              members: new Map(),
              strings: new Set([String(index)]),
            },
            owner,
          ],
          stateForCallbackInvocation(state, callExpression, index),
        );
        const results =
          methodName === 'flatMap' && callbackResult.arrayLike
            ? arrayElements(callbackResult)
            : [callbackResult];
        for (const result of results) {
          members.set(String(resultIndex), result);
          resultIndex += 1;
        }
      });
      return { arrayLike: true, functions: [], kinds: 0, members, strings: undefined };
    }
    if (methodName === 'some' || methodName === 'every' || methodName === 'forEach') {
      elements.forEach((element, index) => {
        invokeFunctions(
          callback,
          [
            element,
            {
              functions: [],
              kinds: 0,
              members: new Map(),
              strings: new Set([String(index)]),
            },
            owner,
          ],
          stateForCallbackInvocation(state, callExpression, index),
        );
      });
      return emptyCallableValue();
    }
    const entries = arrayEntries(owner);
    let accumulator;
    let remaining;
    if (initialValue) {
      accumulator = initialValue;
      remaining = entries;
    } else {
      accumulator = entries[0]?.[1] ?? emptyCallableValue();
      remaining = entries.slice(1);
    }
    remaining.forEach(([index, element]) => {
      accumulator = invokeFunctions(
        callback,
        [
          accumulator,
          element,
          {
            functions: [],
            kinds: 0,
            members: new Map(),
            strings: new Set([index]),
          },
          owner,
        ],
        stateForCallbackInvocation(state, callExpression, index),
      );
    });
    return accumulator;
  }

  function isFunctionPrototypeExpression(expression) {
    const current = unwrapExpression(expression);
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
      return false;
    }
    const memberNames = accessMemberNames(current);
    const owner = unwrapExpression(current.expression);
    return (
      memberNames?.size === 1 &&
      memberNames.has('prototype') &&
      ts.isIdentifier(owner) &&
      isUnshadowedIdentifier(owner, 'Function')
    );
  }

  function intrinsicInvocationMethod(expression) {
    const current = unwrapExpression(expression);
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
      return undefined;
    }
    const methodNames = accessMemberNames(current);
    if (
      !methodNames ||
      methodNames.size !== 1 ||
      (![...methodNames].includes('call') && ![...methodNames].includes('apply'))
    ) {
      return undefined;
    }
    return isFunctionPrototypeExpression(current.expression) ? [...methodNames][0] : undefined;
  }

  function arrayInvocationArguments(expression, value) {
    const current = expression ? unwrapExpression(expression) : undefined;
    return {
      expressions:
        current && ts.isArrayLiteralExpression(current)
          ? [...current.elements].filter((element) => !ts.isOmittedExpression(element))
          : [],
      values: arrayElements({ ...value, arrayLike: true }),
    };
  }

  function intrinsicInvocationArguments(intrinsicKinds, passedArguments) {
    const argumentAlternatives = [];
    if ((intrinsicKinds & CALLABLE_INTRINSIC_CALL) !== 0) {
      argumentAlternatives.push({
        expressions: passedArguments.expressions.slice(1),
        values: passedArguments.values.slice(1),
      });
    }
    if ((intrinsicKinds & CALLABLE_INTRINSIC_APPLY) !== 0) {
      argumentAlternatives.push(
        arrayInvocationArguments(
          passedArguments.expressions[1],
          passedArguments.values[1] ?? emptyCallableValue(),
        ),
      );
    }
    const argumentCount = Math.max(0, ...argumentAlternatives.map(({ values }) => values.length));
    return {
      expressions: Array.from({ length: argumentCount }, (_, index) => {
        const expressions = argumentAlternatives.map(({ expressions }) => expressions[index]);
        return expressions.every((expression) => expression === expressions[0])
          ? expressions[0]
          : undefined;
      }),
      values: Array.from({ length: argumentCount }, (_, index) =>
        mergeCallableValues(...argumentAlternatives.map(({ values }) => values[index])),
      ),
    };
  }

  function invocationTargetValue(expression, value) {
    const kinds = expression ? callableKinds(expression) : 0;
    return kinds === 0 ? value : { ...value, kinds: value.kinds | kinds };
  }

  function normalizeIntrinsicInvocation(invocation) {
    let current = invocation;
    const visitedInvocations = [];
    while (true) {
      const intrinsicKinds = current.callee.kinds & CALLABLE_INTRINSIC_INVOCATION;
      if (intrinsicKinds === 0) return current;
      const targetIdentity = current.thisExpression ?? current.thisValue;
      const repeated = visitedInvocations.some(
        (visited) =>
          visited.intrinsicKinds === intrinsicKinds &&
          visited.targetIdentity === targetIdentity &&
          visited.argumentExpressions.length === current.argumentExpressions.length &&
          visited.argumentExpressions.every(
            (expression, index) => expression === current.argumentExpressions[index],
          ) &&
          visited.argumentValues.length === current.argumentValues.length &&
          visited.argumentValues.every((value, index) => value === current.argumentValues[index]),
      );
      if (repeated) return current;
      visitedInvocations.push({
        argumentExpressions: current.argumentExpressions,
        argumentValues: current.argumentValues,
        intrinsicKinds,
        targetIdentity,
      });
      const argumentsForTarget = intrinsicInvocationArguments(intrinsicKinds, {
        expressions: current.argumentExpressions,
        values: current.argumentValues,
      });
      current = {
        argumentExpressions: argumentsForTarget.expressions,
        argumentValues: argumentsForTarget.values,
        callee: invocationTargetValue(current.thisExpression, current.thisValue),
        thisExpression: current.argumentExpressions[0],
        thisValue: current.argumentValues[0] ?? emptyCallableValue(),
      };
    }
  }

  function nestedIntrinsicInvocation(callExpression, environment, state) {
    const callee = unwrapExpression(callExpression.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return undefined;
    }
    const outerNames = accessMemberNames(callee);
    if (!outerNames || outerNames.size !== 1) return undefined;
    const outerMethod = [...outerNames][0];
    if (outerMethod !== 'call' && outerMethod !== 'apply') return undefined;
    const intrinsicKinds = callableKinds(callee.expression) & CALLABLE_INTRINSIC_INVOCATION;
    if (intrinsicKinds === 0 || !callExpression.arguments[0]) return undefined;

    let passedArguments;
    if (outerMethod === 'call') {
      passedArguments = {
        expressions: callExpression.arguments.slice(1),
        values: callExpression.arguments
          .slice(1)
          .map((argument) => callableValue(argument, environment, state)),
      };
    } else {
      const argumentExpression = callExpression.arguments[1];
      passedArguments = arrayInvocationArguments(
        argumentExpression,
        argumentExpression
          ? callableValue(argumentExpression, environment, state)
          : emptyCallableValue(),
      );
    }
    return normalizeIntrinsicInvocation({
      argumentExpressions: passedArguments.expressions,
      argumentValues: passedArguments.values,
      callee: invocationTargetValue(
        callee.expression,
        callableValue(callee.expression, environment, state),
      ),
      thisExpression: callExpression.arguments[0],
      thisValue: callableValue(callExpression.arguments[0], environment, state),
    });
  }

  function invocationForCall(callExpression, environment, state) {
    const nestedInvocation = nestedIntrinsicInvocation(callExpression, environment, state);
    if (nestedInvocation) return nestedInvocation;
    const calleeExpression = unwrapExpression(callExpression.expression);
    if (
      ts.isPropertyAccessExpression(calleeExpression) ||
      ts.isElementAccessExpression(calleeExpression)
    ) {
      const memberNames = accessMemberNames(calleeExpression);
      if (memberNames?.size === 1 && memberNames.has('call')) {
        return {
          argumentExpressions: callExpression.arguments.slice(1),
          argumentValues: callExpression.arguments
            .slice(1)
            .map((argument) => callableValue(argument, environment, state)),
          callee: callableValue(calleeExpression.expression, environment, state),
        };
      }
      if (memberNames?.size === 1 && memberNames.has('apply')) {
        const argumentExpression = callExpression.arguments[1];
        const argumentArray = argumentExpression
          ? callableValue(argumentExpression, environment, state)
          : emptyCallableValue();
        const appliedArguments = arrayInvocationArguments(argumentExpression, argumentArray);
        return {
          argumentExpressions: appliedArguments.expressions,
          argumentValues: appliedArguments.values,
          callee: callableValue(calleeExpression.expression, environment, state),
        };
      }
    }
    return {
      argumentExpressions: [...callExpression.arguments],
      argumentValues: callExpression.arguments.map((argument) =>
        callableValue(argument, environment, state),
      ),
      callee: callableValue(callExpression.expression, environment, state),
    };
  }

  function recordContextualLoader(
    callExpression,
    targetExpression,
    targetValue,
    environment,
    state,
  ) {
    if (!collectLoaderContexts) return;
    const records = contextualLoaderTargets.get(callExpression) ?? new Map();
    if (environment.size === 0 && records.size > 0) return;
    let staticTargetsForCall = staticLoaderTargetsByCall.get(callExpression);
    if (!staticTargetsForCall && targetExpression) {
      staticTargetsForCall = staticTargets(targetExpression);
      if (staticTargetsForCall) {
        staticLoaderTargetsByCall.set(callExpression, staticTargetsForCall);
      }
    }
    const contextualTargetValue =
      targetExpression && !staticTargetsForCall
        ? (targetValue ??
          callableValue(targetExpression, environment, {
            ...state,
            seenSymbols: new Set(),
          }))
        : (targetValue ?? emptyCallableValue());
    const targets =
      staticTargetsForCall ??
      (contextualTargetValue.strings?.size ? contextualTargetValue.strings : undefined);
    const key = targets ? [...targets].sort().join('\u0000') : '<unresolved>';
    records.set(key, targets);
    contextualLoaderTargets.set(callExpression, records);
  }

  function callableValue(
    expression,
    environment = new Map(),
    state = { callStack: new Set(), seenSymbols: new Set() },
  ) {
    const cacheable =
      collectLoaderContexts &&
      environment.size === 0 &&
      state.callStack.size === 0 &&
      state.seenSymbols.size === 0 &&
      !state.thisValue;
    if (cacheable && contextualValueCache.has(expression)) {
      return contextualValueCache.get(expression);
    }
    const value = normalizeAbstractValue(
      evaluateCallableValue(expression, environment, state),
      expression,
    );
    if (cacheable) contextualValueCache.set(expression, value);
    return value;
  }

  function evaluateCallableValue(expression, environment, state) {
    const current = unwrapExpression(expression);
    if (current.kind === ts.SyntaxKind.TrueKeyword) {
      return {
        ...emptyCallableValue(),
        nullish: MAY_BE_NON_NULLISH,
        truthiness: MAY_BE_TRUTHY,
      };
    }
    if (current.kind === ts.SyntaxKind.FalseKeyword) {
      return {
        ...emptyCallableValue(),
        nullish: MAY_BE_NON_NULLISH,
        truthiness: MAY_BE_FALSY,
      };
    }
    if (ts.isStringLiteralLike(current)) {
      return { functions: [], kinds: 0, members: new Map(), strings: new Set([current.text]) };
    }
    if (ts.isNumericLiteral(current)) {
      return { functions: [], kinds: 0, members: new Map(), strings: new Set([current.text]) };
    }
    if (ts.isNoSubstitutionTemplateLiteral(current)) {
      return { functions: [], kinds: 0, members: new Map(), strings: new Set([current.text]) };
    }
    if (ts.isTemplateExpression(current)) {
      let strings = new Set([current.head.text]);
      for (const span of current.templateSpans) {
        const values = callableValue(span.expression, environment, state).strings;
        if (!values) return emptyCallableValue();
        strings = new Set(
          [...strings].flatMap((prefix) =>
            [...values].map((value) => `${prefix}${value}${span.literal.text}`),
          ),
        );
      }
      return { functions: [], kinds: 0, members: new Map(), strings };
    }
    if (ts.isIdentifier(current)) {
      if (isUnshadowedIdentifier(current, 'require')) {
        return { functions: [], kinds: CALLABLE_LOADER, members: new Map(), strings: undefined };
      }
      const exactSpreadValue = exactTopLevelSpreadValue(current, environment, state);
      if (exactSpreadValue) return exactSpreadValue;
      return callableValueForSymbol(symbolAt(checker, current), environment, state);
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      return state.thisValue ?? emptyCallableValue();
    }
    if (isModuleRequire(current)) {
      return { functions: [], kinds: CALLABLE_LOADER, members: new Map(), strings: undefined };
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const memberNames = accessMemberNames(current, environment, state);
      const exactMemberValue = exactTopLevelContainerMemberValue(
        current,
        memberNames,
        environment,
        state,
      );
      if (exactMemberValue) return exactMemberValue;
      const ownerValue = callableValue(current.expression, environment, state);
      const selectedValue = selectCallableMembers(ownerValue, memberNames);
      const accessorValue =
        selectedValue.accessors.length > 0
          ? mergeCallableValues(
              selectedValue,
              ...selectedValue.accessors.map((record) =>
                functionResult(record, [], stateForInvocation(state, current)),
              ),
            )
          : selectedValue;
      let value =
        (ownerValue.runtimeInstance &&
          selectedMemberIsDefinitelyDefined(ownerValue, memberNames)) ||
        isDeclaredThisAlias(current.expression)
          ? accessorValue
          : mergeCallableValues(storedCallableValue(symbolForValue(current)), accessorValue);
      if (isNodeModuleNamespaceValue(current.expression)) {
        if (!memberNames) {
          unresolvedLoaderExpressions.set(current, current.getSourceFile());
        } else if (memberNames.has('createRequire')) {
          value = mergeCallableValues(value, {
            functions: [],
            kinds: CALLABLE_CREATE_REQUIRE,
            members: new Map(),
            strings: undefined,
          });
        }
      }
      return value;
    }
    if (ts.isCallExpression(current)) {
      if (isBindCall(current)) return callableValue(bindOwner(current), environment, state);
      const arrayMutation = arrayMutationForCall(current);
      if (arrayMutation) {
        const owner = callableValue(arrayMutation.owner, environment, state);
        if (owner.arrayLike) {
          for (const argument of current.arguments) {
            const argumentValue = callableValue(argument, environment, state);
            owner.members.set('*', mergeCallableValues(owner.members.get('*'), argumentValue));
          }
          return emptyCallableValue();
        }
      }
      if (isObjectAssignCall(current)) {
        const [targetExpression, ...sourceExpressions] = current.arguments;
        const target = targetExpression
          ? callableValue(targetExpression, environment, state)
          : emptyCallableValue();
        return assignObjectMembers(
          target,
          sourceExpressions.map((source) => callableValue(source, environment, state)),
        );
      }
      const callbackResult = callbackPipelineResult(current, environment, state);
      if (callbackResult) return callbackResult;
      const invocation = invocationForCall(current, environment, state);
      const callee = invocation.callee;
      if ((callee.kinds & CALLABLE_LOADER) !== 0) {
        recordContextualLoader(
          current,
          invocation.argumentExpressions[0],
          invocation.argumentValues[0],
          environment,
          state,
        );
      }
      const results = [];
      if ((callee.kinds & CALLABLE_CREATE_REQUIRE) !== 0) {
        results.push({
          functions: [],
          kinds: CALLABLE_LOADER,
          members: new Map(),
          strings: undefined,
        });
      }
      for (const record of callee.functions) {
        results.push(
          functionResult(record, invocation.argumentValues, stateForInvocation(state, current)),
        );
      }
      return mergeCallableValues(...results);
    }
    if (ts.isNewExpression(current)) {
      const invocationPath = state.runtimeInvocationPath ?? [];
      const instanceRecords = runtimeClassInstances.get(current) ?? [];
      const existingInstance = instanceRecords.find(
        (record) =>
          record.invocationPath.length === invocationPath.length &&
          record.invocationPath.every((expression, index) => expression === invocationPath[index]),
      );
      if (existingInstance) return existingInstance.value;
      const constructorValue = callableValue(current.expression, environment, state);
      const argumentValues = (current.arguments ?? []).map((argument) =>
        callableValue(argument, environment, state),
      );
      const constructedInstances = (constructorValue.constructors ?? []).map((record) =>
        classInstance(record, argumentValues, stateForInvocation(state, current)),
      );
      const instance =
        constructedInstances.length === 1
          ? constructedInstances[0]
          : mergeCallableAlternatives(...constructedInstances);
      runtimeClassInstances.set(current, [...instanceRecords, { invocationPath, value: instance }]);
      return instance;
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return callableValue(current.right, environment, state);
      }
      if (isLogicalOperator(current.operatorToken.kind)) {
        return mergeCallableAlternatives(
          ...logicalOperands(current, environment, state).map((operand) =>
            callableValue(operand, environment, state),
          ),
        );
      }
      if (current.operatorToken.kind === ts.SyntaxKind.MinusToken) {
        const left =
          callableValue(current.left, environment, state).strings ??
          staticPropertyNames(current.left);
        const right =
          callableValue(current.right, environment, state).strings ??
          staticPropertyNames(current.right);
        return left && right
          ? {
              functions: [],
              kinds: 0,
              members: new Map(),
              strings: new Set(
                [...left].flatMap((leftValue) =>
                  [...right].map((rightValue) => String(Number(leftValue) - Number(rightValue))),
                ),
              ),
            }
          : emptyCallableValue();
      }
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = callableValue(current.left, environment, state).strings;
      const right = callableValue(current.right, environment, state).strings;
      return left && right
        ? {
            functions: [],
            kinds: 0,
            members: new Map(),
            strings: new Set(
              [...left].flatMap((prefix) =>
                [...right].flatMap((value) => {
                  const results = [prefix + value];
                  const numeric = Number(prefix) + Number(value);
                  if (!Number.isNaN(numeric)) results.push(String(numeric));
                  return results;
                }),
              ),
            ),
          }
        : emptyCallableValue();
    }
    if (ts.isConditionalExpression(current)) {
      return mergeCallableAlternatives(
        callableValue(current.whenTrue, environment, state),
        callableValue(current.whenFalse, environment, state),
      );
    }
    if (ts.isAwaitExpression(current)) return callableValue(current.expression, environment, state);
    if (ts.isArrayLiteralExpression(current)) {
      const members = new Map();
      const knownDefinedMembers = new Set();
      let nextIndex = 0;
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) {
          nextIndex += 1;
        } else if (ts.isSpreadElement(element)) {
          const spread = callableValue(element.expression, environment, state);
          for (const [memberName, memberValue] of spread.members) {
            if (memberName === '*') {
              members.set('*', mergeCallableValues(members.get('*'), memberValue));
            } else if (Number.isInteger(Number(memberName))) {
              const targetIndex = String(nextIndex);
              members.set(targetIndex, memberValue);
              if (spread.knownDefinedMembers?.has(memberName)) {
                knownDefinedMembers.add(targetIndex);
              }
              nextIndex += 1;
            }
          }
        } else {
          const memberName = String(nextIndex);
          members.set(memberName, callableValue(element, environment, state));
          if (isDefinitelyDefinedValue(element)) knownDefinedMembers.add(memberName);
          nextIndex += 1;
        }
      }
      return {
        accessors: [],
        arrayIdentities: knownArrayIdentities([current]),
        arrayLike: true,
        functions: [],
        knownDefinedMembers,
        kinds: 0,
        members,
        strings: undefined,
      };
    }
    if (ts.isObjectLiteralExpression(current)) {
      const members = new Map();
      const knownDefinedMembers = new Set();
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = callableValue(property.expression, environment, state);
          const spreadMembersAreKnown = objectSpreadMembersAreKnown(property.expression);
          const definitelyPresentMembers = definitelyPresentObjectSpreadMembers(
            property.expression,
          );
          if (!spreadMembersAreKnown) {
            knownDefinedMembers.clear();
          }
          for (const [memberName, memberValue] of spread.members) {
            const definitelyOverwrites =
              memberName !== '*' &&
              (definitelyPresentMembers.has(memberName) ||
                spread.knownPresentMembers?.has(memberName) ||
                spread.knownDefinedMembers?.has(memberName));
            members.set(
              memberName,
              definitelyOverwrites
                ? memberValue
                : mergeCallableValues(members.get(memberName), memberValue),
            );
            if (spreadMembersAreKnown) knownDefinedMembers.delete(memberName);
            if (spreadMembersAreKnown && spread.knownDefinedMembers?.has(memberName)) {
              knownDefinedMembers.add(memberName);
            }
          }
          continue;
        }
        const memberNames = declarationMemberNames(property.name);
        let memberValue = emptyCallableValue();
        let memberIsDefinitelyDefined = false;
        if (ts.isPropertyAssignment(property)) {
          memberValue = callableValue(property.initializer, environment, state);
          memberIsDefinitelyDefined = isDefinitelyDefinedValue(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          memberValue = callableValue(property.name, environment, state);
          memberIsDefinitelyDefined = isDefinitelyDefinedValue(property.name);
        } else if (ts.isMethodDeclaration(property)) {
          memberValue = {
            functions: [{ environment: capturedEnvironment(environment), functionLike: property }],
            kinds: 0,
            members: new Map(),
            strings: undefined,
          };
          memberIsDefinitelyDefined = true;
        } else if (ts.isGetAccessorDeclaration(property)) {
          memberValue = {
            accessors: [
              {
                environment: capturedEnvironment(environment),
                functionLike: property,
              },
            ],
            functions: [],
            kinds: 0,
            members: new Map(),
            strings: undefined,
          };
          memberIsDefinitelyDefined = true;
        }
        for (const memberName of memberNames ?? ['*']) {
          if (memberName === '*') {
            members.set(memberName, mergeCallableValues(members.get(memberName), memberValue));
            knownDefinedMembers.clear();
          } else {
            members.set(memberName, memberValue);
            knownDefinedMembers.delete(memberName);
          }
          if (memberName !== '*' && memberIsDefinitelyDefined) {
            knownDefinedMembers.add(memberName);
          }
        }
      }
      return { functions: [], knownDefinedMembers, kinds: 0, members, strings: undefined };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return {
        functions: [{ environment: capturedEnvironment(environment), functionLike: current }],
        kinds: 0,
        members: new Map(),
        strings: undefined,
      };
    }
    if (ts.isClassExpression(current)) {
      return classCallableValue(current, environment, state);
    }
    return emptyCallableValue();
  }

  function callableKinds(expression) {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      return (
        (isUnshadowedIdentifier(current, 'require') ? CALLABLE_LOADER : 0) |
        callableKindsForSymbol(symbolAt(checker, current))
      );
    }
    if (isModuleRequire(current)) return CALLABLE_LOADER;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const memberNames = accessMemberNames(current);
      let kinds =
        callableKindsForSymbol(symbolForValue(current)) |
        memberKindsForOwner(current.expression, memberNames);
      const owner = unwrapExpression(current.expression);
      if (
        memberNames?.size === 1 &&
        memberNames.has('assign') &&
        ts.isIdentifier(owner) &&
        isUnshadowedIdentifier(owner, 'Object')
      ) {
        kinds |= CALLABLE_OBJECT_ASSIGN;
      }
      const intrinsicMethod = intrinsicInvocationMethod(current);
      if (intrinsicMethod === 'call') kinds |= CALLABLE_INTRINSIC_CALL;
      if (intrinsicMethod === 'apply') kinds |= CALLABLE_INTRINSIC_APPLY;
      if (isNodeModuleNamespaceValue(current.expression)) {
        if (!memberNames) {
          unresolvedLoaderExpressions.set(current, current.getSourceFile());
        } else if (memberNames.has('createRequire')) {
          kinds |= CALLABLE_CREATE_REQUIRE;
        }
      }
      return kinds;
    }
    if (ts.isCallExpression(current)) {
      if (isBindCall(current)) return callableKinds(bindOwner(current));
      const callee = unwrapExpression(current.expression);
      const nestedTarget =
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        (callableKinds(callee.expression) & CALLABLE_INTRINSIC_INVOCATION) !== 0
          ? current.arguments[0]
          : undefined;
      const invocationOwner =
        nestedTarget ??
        ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        [...(accessMemberNames(callee) ?? [])].some(
          (memberName) => memberName === 'call' || memberName === 'apply',
        )
          ? callee.expression
          : current.expression);
      const calleeKinds = callableKinds(invocationOwner);
      let kinds = calleeKinds & CALLABLE_CREATE_REQUIRE ? CALLABLE_LOADER : 0;
      for (const functionLike of calledFunctionLikes(current)) {
        kinds |= callableReturnsByFunction.get(functionLike) ?? 0;
      }
      return kinds;
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return callableKinds(current.right);
      }
      if (isLogicalOperator(current.operatorToken.kind)) {
        return logicalOperands(current).reduce(
          (kinds, operand) => kinds | callableKinds(operand),
          0,
        );
      }
    }
    if (ts.isConditionalExpression(current)) {
      return callableKinds(current.whenTrue) | callableKinds(current.whenFalse);
    }
    if (ts.isAwaitExpression(current)) return callableKinds(current.expression);
    return 0;
  }

  function isLoaderCallee(expression) {
    return (callableKinds(expression) & CALLABLE_LOADER) !== 0;
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

  function functionReturnKinds(functionLike) {
    if (ts.isArrowFunction(functionLike) && !ts.isBlock(functionLike.body)) {
      return callableKinds(functionLike.body);
    }
    if (!functionLike.body || !ts.isBlock(functionLike.body)) return 0;
    let kinds = 0;
    function visit(node) {
      if (node !== functionLike && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) {
        kinds |= callableKinds(node.expression);
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(functionLike.body);
    return kinds;
  }

  function addFunctionReturnKinds(functionLike, kinds) {
    if (kinds === 0) return false;
    const existing = callableReturnsByFunction.get(functionLike) ?? 0;
    const combined = existing | kinds;
    if (combined === existing) return false;
    callableReturnsByFunction.set(functionLike, combined);
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
          changed =
            addCallableKinds(symbolAt(checker, property.name), CALLABLE_CREATE_REQUIRE) || changed;
        }
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === 'createRequire'
      ) {
        changed =
          addCallableKinds(symbolAt(checker, property.name), CALLABLE_CREATE_REQUIRE) || changed;
      } else if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === 'createRequire' &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        changed =
          addCallableKinds(
            symbolAt(checker, unwrapExpression(property.initializer)),
            CALLABLE_CREATE_REQUIRE,
          ) || changed;
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
          changed = addCallableKinds(symbolAt(checker, element.name), CALLABLE_LOADER) || changed;
        }
      }
      return changed;
    }
    if (!ts.isObjectLiteralExpression(current)) return false;
    let changed = false;
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'require') {
        changed = addCallableKinds(symbolAt(checker, property.name), CALLABLE_LOADER) || changed;
      } else if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === 'require' &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        changed =
          addCallableKinds(
            symbolAt(checker, unwrapExpression(property.initializer)),
            CALLABLE_LOADER,
          ) || changed;
      }
    }
    return changed;
  }

  function addObjectAssignDestructuredAliases(target) {
    const current = unwrapExpression(target);
    const properties = ts.isObjectBindingPattern(current)
      ? current.elements
      : ts.isObjectLiteralExpression(current)
        ? current.properties
        : [];
    let changed = false;
    for (const property of properties) {
      let memberNames;
      let alias;
      if (ts.isBindingElement(property)) {
        memberNames = property.propertyName
          ? declarationMemberNames(property.propertyName)
          : ts.isIdentifier(property.name)
            ? new Set([property.name.text])
            : undefined;
        alias = ts.isIdentifier(property.name) ? symbolAt(checker, property.name) : undefined;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        memberNames = new Set([property.name.text]);
        alias = checker.getShorthandAssignmentValueSymbol(property);
      } else if (ts.isPropertyAssignment(property)) {
        memberNames = declarationMemberNames(property.name);
        let assignmentTarget = unwrapExpression(property.initializer);
        if (
          ts.isBinaryExpression(assignmentTarget) &&
          assignmentTarget.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          assignmentTarget = unwrapExpression(assignmentTarget.left);
        }
        alias = ts.isIdentifier(assignmentTarget) ? symbolAt(checker, assignmentTarget) : undefined;
      }
      if (memberNames?.has('assign')) {
        changed = addCallableKinds(alias, CALLABLE_OBJECT_ASSIGN) || changed;
      }
    }
    return changed;
  }

  function addIntrinsicInvocationDestructuredAliases(target) {
    const current = unwrapExpression(target);
    const properties = ts.isObjectBindingPattern(current)
      ? current.elements
      : ts.isObjectLiteralExpression(current)
        ? current.properties
        : [];
    let changed = false;
    for (const property of properties) {
      let memberName;
      let alias;
      if (ts.isBindingElement(property) && ts.isIdentifier(property.name)) {
        memberName = property.propertyName?.getText() ?? property.name.text;
        alias = property.name;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        memberName = property.name.text;
        alias = property.name;
      } else if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        memberName = propertyNameText(property.name);
        alias = unwrapExpression(property.initializer);
      }
      const kinds =
        memberName === 'call'
          ? CALLABLE_INTRINSIC_CALL
          : memberName === 'apply'
            ? CALLABLE_INTRINSIC_APPLY
            : 0;
      changed = addCallableKinds(alias ? symbolAt(checker, alias) : undefined, kinds) || changed;
    }
    return changed;
  }

  function declarationMemberNames(name) {
    if (ts.isComputedPropertyName(name)) return staticPropertyNames(name.expression);
    return new Set([propertyNameText(name)]);
  }

  function copyContainerProvenance(targetSymbol, sourceSymbol) {
    if (!targetSymbol || !sourceSymbol) return false;
    let changed = false;
    for (const [memberName, kinds] of memberMapForSymbol(callableMembersBySymbol, sourceSymbol)) {
      changed = addMemberKinds(targetSymbol, new Set([memberName]), kinds) || changed;
    }
    for (const [memberName, targets] of memberSetMapForSymbol(
      functionMembersBySymbol,
      sourceSymbol,
    )) {
      changed = addMemberFunctionTargets(targetSymbol, new Set([memberName]), targets) || changed;
    }
    for (const [memberName, references] of memberSetMapForSymbol(
      memberReferencesBySymbol,
      sourceSymbol,
    )) {
      changed = addMemberReferences(targetSymbol, new Set([memberName]), references) || changed;
    }
    return changed;
  }

  function referenceSymbolsForExpression(expression, seen = new Set()) {
    const current = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      addContainerProvenance(current, current);
      return new Set([current]);
    }
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(checker, current);
      if (!symbol) return new Set();
      const identity = aliasedSymbol(checker, symbol) ?? symbol;
      return containerSymbols.has(identity)
        ? union(new Set([identity]), arrayIdentitiesForSymbol(identity))
        : new Set();
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const references = new Set();
      const memberNames = accessMemberNames(current);
      for (const ownerReference of referenceSymbolsForExpression(current.expression, seen)) {
        if (seen.has(ownerReference)) continue;
        const members = memberSetMapForSymbol(memberReferencesBySymbol, ownerReference);
        const selected = memberNames ?? new Set(members.keys());
        for (const memberName of union(selected, new Set(['*']))) {
          for (const reference of members.get(memberName) ?? []) references.add(reference);
        }
      }
      return references;
    }
    if (ts.isConditionalExpression(current)) {
      return union(
        referenceSymbolsForExpression(current.whenTrue, seen),
        referenceSymbolsForExpression(current.whenFalse, seen),
      );
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return referenceSymbolsForExpression(current.right, seen);
      }
      if (isLogicalOperator(current.operatorToken.kind)) {
        return union(
          ...logicalOperands(current).map((operand) =>
            referenceSymbolsForExpression(operand, seen),
          ),
        );
      }
    }
    return new Set();
  }

  function addContainerProvenance(targetSymbol, expression) {
    if (!targetSymbol) return false;
    const current = unwrapExpression(expression);
    let changed = false;
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      const identity = aliasedSymbol(checker, targetSymbol) ?? targetSymbol;
      if (!containerSymbols.has(identity)) {
        containerSymbols.add(identity);
        changed = true;
      }
      if (ts.isArrayLiteralExpression(current)) {
        changed = addArrayIdentities(identity, new Set([current])) || changed;
      }
    }
    const sourceSymbol = symbolForValue(current);
    if (
      sourceSymbol &&
      containerSymbols.has(aliasedSymbol(checker, sourceSymbol) ?? sourceSymbol)
    ) {
      const identity = aliasedSymbol(checker, targetSymbol) ?? targetSymbol;
      if (!containerSymbols.has(identity)) {
        containerSymbols.add(identity);
        changed = true;
      }
      changed = addArrayIdentities(identity, arrayIdentitiesForSymbol(sourceSymbol)) || changed;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          changed =
            copyContainerProvenance(targetSymbol, symbolForValue(property.expression)) || changed;
          continue;
        }
        const memberNames = declarationMemberNames(property.name);
        const valueExpression = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property;
        changed =
          addMemberKinds(targetSymbol, memberNames, callableKinds(valueExpression)) || changed;
        changed =
          addMemberFunctionTargets(
            targetSymbol,
            memberNames,
            functionTargetsForExpression(valueExpression),
          ) || changed;
        changed =
          addMemberReferences(
            targetSymbol,
            memberNames,
            referenceSymbolsForExpression(valueExpression),
          ) || changed;
      }
    } else if (ts.isArrayLiteralExpression(current)) {
      current.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        if (ts.isSpreadElement(element)) {
          changed =
            copyContainerProvenance(targetSymbol, symbolForValue(element.expression)) || changed;
          return;
        }
        const memberNames = new Set([String(index)]);
        changed = addMemberKinds(targetSymbol, memberNames, callableKinds(element)) || changed;
        changed =
          addMemberFunctionTargets(
            targetSymbol,
            memberNames,
            functionTargetsForExpression(element),
          ) || changed;
        changed =
          addMemberReferences(targetSymbol, memberNames, referenceSymbolsForExpression(element)) ||
          changed;
      });
    } else {
      changed = copyContainerProvenance(targetSymbol, symbolForValue(current)) || changed;
    }
    return changed;
  }

  function addAssignmentCallableProvenance(target, kinds, functionTargets, references) {
    const current = unwrapExpression(target);
    if (ts.isIdentifier(current)) {
      return (
        addCallableKinds(symbolAt(checker, current), kinds) |
        addFunctionTargets(symbolAt(checker, current), functionTargets)
      );
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const memberNames = accessMemberNames(current) ?? new Set(['*']);
      const ownerSymbol = symbolForValue(current.expression);
      const ownerReferences = referenceSymbolsForExpression(current.expression);
      let changed = false;
      for (const ownerReference of union(
        ownerReferences,
        ownerSymbol ? new Set([ownerSymbol]) : new Set(),
      )) {
        changed = addMemberKinds(ownerReference, memberNames, kinds) || changed;
        changed = addMemberFunctionTargets(ownerReference, memberNames, functionTargets) || changed;
        changed = addMemberReferences(ownerReference, memberNames, references) || changed;
      }
      return (
        addCallableKinds(symbolForValue(current), kinds) |
        addFunctionTargets(symbolForValue(current), functionTargets) |
        addMemberKinds(ownerSymbol, memberNames, kinds) |
        addMemberFunctionTargets(ownerSymbol, memberNames, functionTargets) |
        addMemberReferences(ownerSymbol, memberNames, references) |
        changed
      );
    }
    return false;
  }

  function objectMutationTargetSymbols(expression) {
    const symbol = symbolForValue(expression);
    return union(referenceSymbolsForExpression(expression), symbol ? new Set([symbol]) : new Set());
  }

  function literalSwitchKey(expression, seenSymbols = new Set()) {
    const current = unwrapExpression(expression);
    if (current.kind === ts.SyntaxKind.NullKeyword) return 'null';
    if (current.kind === ts.SyntaxKind.TrueKeyword) return 'boolean:true';
    if (current.kind === ts.SyntaxKind.FalseKeyword) return 'boolean:false';
    if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      return `string:${current.text}`;
    }
    if (ts.isNumericLiteral(current)) return `number:${Number(current.text)}`;
    if (!ts.isIdentifier(current)) return undefined;
    if (current.text === 'undefined' && isUnshadowedIdentifier(current, 'undefined')) {
      return 'undefined';
    }
    const symbol = symbolAt(checker, current);
    const identity = aliasedSymbol(checker, symbol) ?? symbol;
    if (!identity || seenSymbols.has(identity)) return undefined;
    const declarations = identity.declarations ?? [];
    if (declarations.length === 0) return undefined;
    const keys = new Set();
    for (const declaration of declarations) {
      if (
        !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer ||
        (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0
      ) {
        return undefined;
      }
      const key = literalSwitchKey(declaration.initializer, new Set([...seenSymbols, identity]));
      if (key === undefined) return undefined;
      keys.add(key);
    }
    return keys.size === 1 ? [...keys][0] : undefined;
  }

  function containingSourceFileStatement(node) {
    let current = node;
    while (current && !ts.isSourceFile(current.parent)) {
      if (ts.isFunctionLike(current)) return undefined;
      current = current.parent;
    }
    return current && ts.isStatement(current) ? current : undefined;
  }

  function containingArrayMutationScopeStatement(node) {
    let current = node;
    while (current?.parent) {
      if (ts.isSourceFile(current.parent)) {
        return ts.isStatement(current)
          ? { statement: current, statements: current.parent.statements }
          : undefined;
      }
      if (
        ts.isBlock(current.parent) &&
        ts.isFunctionLike(current.parent.parent) &&
        current.parent.parent.body === current.parent
      ) {
        return ts.isStatement(current)
          ? { statement: current, statements: current.parent.statements }
          : undefined;
      }
      if (ts.isFunctionLike(current)) return undefined;
      current = current.parent;
    }
    return undefined;
  }

  const sourceOrderedEvaluationCache = new Map();
  const sourceOrderedPreludeStateCache = new Map();
  const sourceOrderedEvaluationStack = new Set();

  function sourceOrderedArrayMutationValue(contextNode, expression) {
    const scope = containingArrayMutationScopeStatement(contextNode);
    if (!scope) return unknownCallableValue();
    if (sourceOrderedEvaluationCache.has(contextNode)) {
      return sourceOrderedEvaluationCache.get(contextNode);
    }
    if (sourceOrderedEvaluationStack.size > 0) return unknownCallableValue();
    sourceOrderedEvaluationStack.add(contextNode);

    try {
      const targetExpression = unwrapExpression(expression);
      const targetValues = [];

      const createState = () => ({
        bindings: new Map(),
        callStack: new Set(),
        dataOnly: new Map(),
        environment: new Map(),
        thisValue: undefined,
      });
      const cloneValue = (value, seen = new Map()) => {
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value)) return seen.get(value);
        const cloned = { ...value };
        seen.set(value, cloned);
        cloned.accessors = [...(value.accessors ?? [])];
        cloned.arrayIdentities = cloneArrayIdentities(value.arrayIdentities);
        cloned.constructors = [...(value.constructors ?? [])];
        cloned.functions = [...(value.functions ?? [])];
        cloned.knownDefinedMembers = new Set(value.knownDefinedMembers ?? []);
        cloned.knownPresentMembers = value.knownPresentMembers
          ? new Set(value.knownPresentMembers)
          : undefined;
        cloned.members = new Map(
          [...(value.members ?? [])].map(([name, member]) => [name, cloneValue(member, seen)]),
        );
        cloned.references = new Set(value.references ?? []);
        cloned.strings = value.strings ? new Set(value.strings) : undefined;
        return cloned;
      };
      const cloneState = (state) => ({
        bindings: new Map(
          [...state.bindings].map(([identity, value]) => [identity, cloneValue(value)]),
        ),
        callStack: new Set(state.callStack),
        dataOnly: new Map(
          [...state.dataOnly].map(([identity, container]) => [
            identity,
            { members: new Set(container.members) },
          ]),
        ),
        environment: new Map(state.environment),
        thisValue: state.thisValue ? cloneValue(state.thisValue) : undefined,
      });
      const mergeRuntimeValues = (...candidates) => {
        const values = candidates.filter(Boolean).map((value) => normalizeAbstractValue(value));
        if (values.length === 0) return unknownCallableValue();
        const merged = mergeCallableAlternatives(...values);
        merged.arrayIdentities = mergeArrayIdentities(values);
        merged.arrayLike =
          merged.arrayIdentities.kind === 'unknown' || merged.arrayIdentities.values.size > 0;
        merged.nullish = values.reduce(
          (facts, value) => facts | (value.nullish ?? MAY_BE_NULLISH | MAY_BE_NON_NULLISH),
          0,
        );
        merged.truthiness = values.reduce(
          (facts, value) => facts | (value.truthiness ?? MAY_BE_TRUTHY | MAY_BE_FALSY),
          0,
        );
        return merged;
      };
      const mergeDataOnly = (states) => {
        const merged = new Map();
        if (states.length === 0) return merged;
        for (const [identity, container] of states[0].dataOnly) {
          const alternatives = states.slice(1).map((state) => state.dataOnly.get(identity));
          if (alternatives.some((alternative) => !alternative)) continue;
          merged.set(identity, {
            members: new Set(
              [...container.members].filter((memberName) =>
                alternatives.every((alternative) => alternative.members.has(memberName)),
              ),
            ),
          });
        }
        return merged;
      };
      const mergeStates = (states) => {
        if (states.length === 1) return cloneState(states[0]);
        const merged = createState();
        const identities = union(...states.map((state) => new Set(state.bindings.keys())));
        for (const identity of identities) {
          merged.bindings.set(
            identity,
            mergeRuntimeValues(
              ...states.map((state) => state.bindings.get(identity) ?? unknownCallableValue()),
            ),
          );
        }
        merged.callStack = new Set(states[0]?.callStack ?? []);
        merged.dataOnly = mergeDataOnly(states);
        merged.environment = new Map(states[0]?.environment ?? []);
        merged.thisValue = states.some((state) => state.thisValue)
          ? mergeRuntimeValues(...states.map((state) => state.thisValue ?? unknownCallableValue()))
          : undefined;
        return merged;
      };
      const replaceState = (target, source) => {
        target.bindings = source.bindings;
        target.callStack = source.callStack;
        target.dataOnly = source.dataOnly;
        target.environment = source.environment;
        target.thisValue = source.thisValue;
      };
      const runtimeEnvironment = (state) => {
        const environment = new Map(state.environment);
        for (const [identity, value] of state.bindings) environment.set(identity, value);
        return environment;
      };
      const staticState = (state) => ({
        callStack: state.callStack,
        seenSymbols: new Set(),
        thisValue: state.thisValue,
      });
      const knownNonArrayValue = (value = emptyCallableValue(), facts = {}) => ({
        ...withArrayIdentities(value, knownArrayIdentities()),
        ...facts,
        arrayLike: false,
      });
      const undefinedValue = () =>
        knownNonArrayValue(emptyCallableValue(), {
          nullish: MAY_BE_NULLISH,
          truthiness: MAY_BE_FALSY,
        });
      const booleanValue = (truthiness) =>
        knownNonArrayValue(emptyCallableValue(), {
          nullish: MAY_BE_NON_NULLISH,
          truthiness,
        });
      const withRuntimeFacts = (value, current, state) => {
        const normalized = normalizeAbstractValue(value, current);
        if (
          normalized.arrayIdentities.kind === 'known' &&
          normalized.arrayIdentities.values.size > 0
        ) {
          return withArrayIdentities(normalized, normalized.arrayIdentities, current);
        }
        const facts = runtimePossibilities(current, runtimeEnvironment(state), staticState(state));
        return { ...normalized, ...facts };
      };
      const isStableBinding = (identity) => {
        const declarations = identity.declarations ?? [];
        return (
          declarations.length > 0 &&
          declarations.every(
            (declaration) =>
              ts.isVariableDeclaration(declaration) &&
              (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0,
          )
        );
      };
      const invalidateReassignableBindings = (state) => {
        for (const [identity, value] of state.bindings) {
          if (!isStableBinding(identity)) state.bindings.set(identity, unknownCallableValue(value));
        }
        state.dataOnly.clear();
      };
      function dataOnlyValueEvaluationIsNeutral(valueExpression, state) {
        const current = unwrapExpression(valueExpression);
        if (
          ts.isStringLiteralLike(current) ||
          ts.isNumericLiteral(current) ||
          current.kind === ts.SyntaxKind.NullKeyword ||
          current.kind === ts.SyntaxKind.TrueKeyword ||
          current.kind === ts.SyntaxKind.FalseKeyword ||
          ts.isIdentifier(current)
        ) {
          return true;
        }
        if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
          return !!dataOnlyContainerForExpression(current, state);
        }
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          return dataOnlyMemberRead(current, state);
        }
        return false;
      }
      function dataOnlyContainerForExpression(valueExpression, state) {
        const current = unwrapExpression(valueExpression);
        if (ts.isIdentifier(current)) {
          const identity = valueSymbolIdentity(current);
          return identity ? state.dataOnly.get(identity) : undefined;
        }
        if (ts.isArrayLiteralExpression(current)) {
          const members = new Set();
          for (let index = 0; index < current.elements.length; index += 1) {
            const element = current.elements[index];
            if (ts.isOmittedExpression(element)) continue;
            if (ts.isSpreadElement(element) || !dataOnlyValueEvaluationIsNeutral(element, state)) {
              return undefined;
            }
            members.add(String(index));
          }
          return { members };
        }
        if (!ts.isObjectLiteralExpression(current)) return undefined;
        const members = new Set();
        for (const property of current.properties) {
          if (ts.isSpreadAssignment(property)) {
            const spread = dataOnlyContainerForExpression(property.expression, state);
            if (!spread) return undefined;
            for (const memberName of spread.members) members.add(memberName);
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            return undefined;
          }
          if (
            ts.isComputedPropertyName(property.name) &&
            !dataOnlyValueEvaluationIsNeutral(property.name.expression, state)
          ) {
            return undefined;
          }
          const memberNames = declarationMemberNames(property.name);
          if (!memberNames || memberNames.size !== 1 || memberNames.has('__proto__')) {
            return undefined;
          }
          const memberExpression = ts.isPropertyAssignment(property)
            ? property.initializer
            : property.name;
          if (!dataOnlyValueEvaluationIsNeutral(memberExpression, state)) return undefined;
          for (const memberName of memberNames) members.add(memberName);
        }
        return { members };
      }
      function dataOnlyMemberRead(access, state) {
        const container = dataOnlyContainerForExpression(access.expression, state);
        const memberNames = accessMemberNames(access);
        return (
          !!container &&
          !!memberNames &&
          memberNames.size > 0 &&
          [...memberNames].every((memberName) => container.members.has(memberName))
        );
      }
      const bindIdentity = (identifier, value, state, sourceExpression) => {
        const identity = valueSymbolIdentity(identifier);
        if (!identity) return;
        const boundValue = cloneValue(value);
        const source = sourceExpression ? unwrapExpression(sourceExpression) : undefined;
        if (
          (boundValue.references?.size ?? 0) > 0 ||
          boundValue.arrayIdentities.kind === 'unknown' ||
          boundValue.arrayIdentities.values.size > 0 ||
          (source && (ts.isObjectLiteralExpression(source) || ts.isArrayLiteralExpression(source)))
        ) {
          boundValue.references ??= new Set();
          boundValue.references.add(identity);
        }
        state.bindings.set(identity, boundValue);
        const dataOnly = sourceExpression
          ? dataOnlyContainerForExpression(sourceExpression, state)
          : undefined;
        if (dataOnly) state.dataOnly.set(identity, dataOnly);
        else state.dataOnly.delete(identity);
      };
      const visitRuntimeValues = (state, visitor) => {
        const seen = new Set();
        const values = [];
        const visit = (value) => {
          if (!value || seen.has(value)) return;
          seen.add(value);
          values.push(value);
          for (const member of value.members?.values() ?? []) visit(member);
        };
        for (const value of state.bindings.values()) visit(value);
        for (const value of values) visitor(value);
      };
      const selectedRuntimeMember = (value, memberNames) => {
        if (
          memberNames?.size > 0 &&
          [...memberNames].every((memberName) => value.knownDefinedMembers.has(memberName))
        ) {
          const members = [...memberNames].map((memberName) => value.members.get(memberName));
          return members.length === 1 ? members[0] : mergeRuntimeValues(...members);
        }
        const selected = selectCallableMembers(value, memberNames);
        if (selected.accessors.length === 0) return selected;
        return { ...selected, accessors: [] };
      };
      function bindPattern(pattern, value, state, sourceExpression) {
        const current = unwrapExpression(pattern);
        if (ts.isIdentifier(current)) {
          bindIdentity(current, value, state, sourceExpression);
          return;
        }
        if (
          ts.isBinaryExpression(current) &&
          current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const selected =
            value.nullish === MAY_BE_NULLISH ? evaluateExpression(current.right, state) : value;
          bindPattern(current.left, selected, state, current.right);
          return;
        }
        if (ts.isObjectBindingPattern(current) || ts.isObjectLiteralExpression(current)) {
          const properties = ts.isObjectBindingPattern(current)
            ? current.elements
            : current.properties;
          for (const [index, property] of properties.entries()) {
            if (ts.isBindingElement(property)) {
              const memberNames = property.propertyName
                ? declarationMemberNames(property.propertyName)
                : ts.isIdentifier(property.name)
                  ? new Set([property.name.text])
                  : undefined;
              const selected = property.dotDotDotToken
                ? restCallableValue(value, current, index)
                : selectedRuntimeMember(value, memberNames);
              bindPattern(property.name, selected, state);
            } else if (ts.isSpreadAssignment(property)) {
              bindPattern(property.expression, restCallableValue(value, current, index), state);
            } else if (ts.isPropertyAssignment(property)) {
              bindPattern(
                property.initializer,
                selectedRuntimeMember(value, declarationMemberNames(property.name)),
                state,
              );
            } else if (ts.isShorthandPropertyAssignment(property)) {
              bindPattern(
                property.name,
                selectedRuntimeMember(value, new Set([property.name.text])),
                state,
              );
            }
          }
          return;
        }
        if (ts.isArrayBindingPattern(current) || ts.isArrayLiteralExpression(current)) {
          for (const [index, element] of current.elements.entries()) {
            if (ts.isOmittedExpression(element)) continue;
            if (ts.isBindingElement(element)) {
              const selected = element.dotDotDotToken
                ? restCallableValue(value, current, index)
                : selectedRuntimeMember(value, new Set([String(index)]));
              bindPattern(element.name, selected, state);
            } else if (ts.isSpreadElement(element)) {
              bindPattern(element.expression, restCallableValue(value, current, index), state);
            } else {
              bindPattern(element, selectedRuntimeMember(value, new Set([String(index)])), state);
            }
          }
          return;
        }
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          const owner = evaluateExpression(current.expression, state);
          if (ts.isElementAccessExpression(current)) {
            evaluateExpression(current.argumentExpression, state);
          }
          for (const memberName of accessMemberNames(current, runtimeEnvironment(state)) ?? ['*']) {
            owner.members.set(memberName, cloneValue(value));
            if (memberName !== '*') owner.knownDefinedMembers.add(memberName);
            visitRuntimeValues(state, (boundValue) => {
              const sharesArrayIdentity =
                owner.arrayIdentities.kind === 'known' &&
                boundValue.arrayIdentities.kind === 'known' &&
                [...owner.arrayIdentities.values].some((identity) =>
                  boundValue.arrayIdentities.values.has(identity),
                );
              const sharesObjectIdentity = [...(owner.references ?? [])].some((identity) =>
                boundValue.references?.has(identity),
              );
              if (!sharesArrayIdentity && !sharesObjectIdentity) return;
              boundValue.members.set(memberName, cloneValue(value));
              if (memberName !== '*') boundValue.knownDefinedMembers.add(memberName);
            });
          }
        }
      }
      const logicalReachability = (value, kind) => ({
        left:
          (kind === ts.SyntaxKind.BarBarToken && (value.truthiness & MAY_BE_TRUTHY) !== 0) ||
          (kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            (value.truthiness & MAY_BE_FALSY) !== 0) ||
          (kind === ts.SyntaxKind.QuestionQuestionToken &&
            (value.nullish & MAY_BE_NON_NULLISH) !== 0),
        right:
          (kind === ts.SyntaxKind.BarBarToken && (value.truthiness & MAY_BE_FALSY) !== 0) ||
          (kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            (value.truthiness & MAY_BE_TRUTHY) !== 0) ||
          (kind === ts.SyntaxKind.QuestionQuestionToken && (value.nullish & MAY_BE_NULLISH) !== 0),
      });
      const mergeExpressionBranches = (state, branches) => {
        replaceState(state, mergeStates(branches.map((branch) => branch.state)));
        return mergeRuntimeValues(...branches.map((branch) => branch.value));
      };
      function evaluateArrayLiteral(current, state) {
        const members = new Map();
        const knownDefinedMembers = new Set();
        let index = 0;
        for (const element of current.elements) {
          if (ts.isOmittedExpression(element)) {
            index += 1;
            continue;
          }
          if (ts.isSpreadElement(element)) {
            const spread = evaluateExpression(element.expression, state);
            for (const [memberName, memberValue] of materializedMembers(spread)) {
              if (memberName === '*') {
                members.set('*', mergeRuntimeValues(members.get('*'), memberValue));
              } else if (Number.isInteger(Number(memberName))) {
                members.set(String(index), memberValue);
                knownDefinedMembers.add(String(index));
                index += 1;
              }
            }
            continue;
          }
          const memberName = String(index);
          members.set(memberName, evaluateExpression(element, state));
          knownDefinedMembers.add(memberName);
          index += 1;
        }
        return withArrayIdentities(
          {
            ...emptyCallableValue(),
            knownDefinedMembers,
            members,
            nullish: MAY_BE_NON_NULLISH,
            references: new Set([current]),
            truthiness: MAY_BE_TRUTHY,
          },
          knownArrayIdentities([current]),
          current,
        );
      }
      function evaluateObjectLiteral(current, state) {
        const value = knownNonArrayValue(emptyCallableValue(), {
          nullish: MAY_BE_NON_NULLISH,
          references: new Set([current]),
          truthiness: MAY_BE_TRUTHY,
        });
        for (const property of current.properties) {
          if (property.name && ts.isComputedPropertyName(property.name)) {
            evaluateExpression(property.name.expression, state);
          }
          if (ts.isSpreadAssignment(property)) {
            const spread = evaluateExpression(property.expression, state);
            for (const [memberName, member] of spread.members) {
              let spreadMember = member;
              if (member.accessors?.length) {
                spreadMember = mergeRuntimeValues(
                  ...member.accessors.map((record) => invokeFunction(record, [], state, spread)),
                );
              }
              value.members.set(memberName, spreadMember);
              if (memberName !== '*') value.knownDefinedMembers.add(memberName);
            }
            continue;
          }
          const memberNames = declarationMemberNames(property.name) ?? new Set(['*']);
          let memberValue = undefinedValue();
          if (ts.isPropertyAssignment(property)) {
            memberValue = evaluateExpression(property.initializer, state);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            memberValue = evaluateExpression(property.name, state);
          } else if (ts.isMethodDeclaration(property)) {
            memberValue = knownNonArrayValue({
              ...emptyCallableValue(),
              functions: [
                {
                  environment: new Map(runtimeEnvironment(state)),
                  functionLike: property,
                  thisValue: value,
                },
              ],
            });
          } else if (ts.isGetAccessorDeclaration(property)) {
            memberValue = knownNonArrayValue({
              ...emptyCallableValue(),
              accessors: [
                {
                  environment: new Map(runtimeEnvironment(state)),
                  functionLike: property,
                  thisValue: value,
                },
              ],
            });
          }
          for (const memberName of memberNames) {
            value.members.set(memberName, memberValue);
            if (memberName !== '*') value.knownDefinedMembers.add(memberName);
          }
        }
        return value;
      }
      function evaluatePropertyAccess(current, state) {
        const owner = evaluateExpression(current.expression, state);
        if (ts.isElementAccessExpression(current)) {
          evaluateExpression(current.argumentExpression, state);
        }
        const memberNames = accessMemberNames(
          current,
          runtimeEnvironment(state),
          staticState(state),
        );
        const selected = selectedRuntimeMember(owner, memberNames);
        if (selected.accessors.length > 0) {
          return mergeRuntimeValues(
            ...selected.accessors.map((record) => invokeFunction(record, [], state, owner)),
          );
        }
        const selectedWithOwner = {
          ...selected,
          functions: selected.functions.map((record) => ({
            ...record,
            thisValue: record.thisValue ?? owner,
          })),
        };
        if (callableValueHasData(selectedWithOwner)) return selectedWithOwner;
        if (dataOnlyMemberRead(current, state)) return undefinedValue();
        const staticValue = storedCallableValue(symbolForValue(current));
        if (callableValueHasData(staticValue)) return staticValue;
        invalidateReassignableBindings(state);
        return unknownCallableValue();
      }
      function invokeFunction(record, argumentValues, state, thisValue) {
        const functionLike = record.functionLike;
        if (!functionLike?.body || state.callStack.has(functionLike)) {
          invalidateReassignableBindings(state);
          return unknownCallableValue();
        }
        const invocationState = cloneState(state);
        invocationState.callStack.add(functionLike);
        invocationState.environment = new Map([
          ...invocationState.environment,
          ...(record.environment ?? []),
        ]);
        invocationState.thisValue = record.thisValue ?? thisValue ?? invocationState.thisValue;
        functionLike.parameters.forEach((parameter, index) => {
          const argumentValue = argumentValues[index] ?? undefinedValue();
          bindPattern(parameter.name, argumentValue, invocationState);
        });
        let outcomes;
        if (ts.isBlock(functionLike.body)) {
          outcomes = evaluateStatementList(functionLike.body.statements, [
            { completion: 'normal', state: invocationState },
          ]);
        } else {
          outcomes = [
            {
              completion: 'return',
              state: invocationState,
              value: evaluateExpression(functionLike.body, invocationState),
            },
          ];
        }
        if (outcomes.length === 0) {
          invalidateReassignableBindings(state);
          return unknownCallableValue();
        }
        const mergedState = mergeStates(outcomes.map((outcome) => outcome.state));
        mergedState.callStack = new Set(state.callStack);
        mergedState.environment = new Map(state.environment);
        mergedState.thisValue = state.thisValue;
        replaceState(state, mergedState);
        return mergeRuntimeValues(
          ...outcomes.map((outcome) =>
            outcome.completion === 'return' ? outcome.value : undefinedValue(),
          ),
        );
      }
      function constructRuntimeValue(record, argumentValues, state, newExpression) {
        const classLike = record.classLike;
        if (!classLike || state.callStack.has(classLike)) {
          invalidateReassignableBindings(state);
          return unknownCallableValue();
        }
        const instance = knownNonArrayValue(
          {
            ...emptyCallableValue(),
            references: new Set([newExpression]),
            runtimeInstance: true,
          },
          { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY },
        );
        const classState = cloneState(state);
        classState.callStack.add(classLike);
        classState.environment = new Map([
          ...classState.environment,
          ...(record.environment ?? []),
        ]);
        classState.thisValue = instance;
        const constructor = classLike.members.find((member) => ts.isConstructorDeclaration(member));
        for (const member of classLike.members) {
          if (hasModifier(member, ts.SyntaxKind.StaticKeyword) || !member.name) continue;
          if (ts.isComputedPropertyName(member.name)) {
            evaluateExpression(member.name.expression, classState);
          }
          const memberNames = declarationMemberNames(member.name) ?? new Set(['*']);
          let memberValue;
          if (ts.isPropertyDeclaration(member)) {
            memberValue = member.initializer
              ? evaluateExpression(member.initializer, classState)
              : undefinedValue();
          } else if (ts.isMethodDeclaration(member)) {
            memberValue = knownNonArrayValue({
              ...emptyCallableValue(),
              functions: [
                {
                  environment: new Map(runtimeEnvironment(classState)),
                  functionLike: member,
                  thisValue: instance,
                },
              ],
            });
          } else if (ts.isGetAccessorDeclaration(member)) {
            memberValue = knownNonArrayValue({
              ...emptyCallableValue(),
              accessors: [
                {
                  environment: new Map(runtimeEnvironment(classState)),
                  functionLike: member,
                  thisValue: instance,
                },
              ],
            });
          } else {
            continue;
          }
          for (const memberName of memberNames) {
            instance.members.set(memberName, memberValue);
            if (memberName !== '*') instance.knownDefinedMembers.add(memberName);
          }
        }
        if (constructor) {
          for (const [index, parameter] of constructor.parameters.entries()) {
            if (
              !ts.isIdentifier(parameter.name) ||
              !parameter.modifiers?.some((modifier) =>
                [
                  ts.SyntaxKind.PublicKeyword,
                  ts.SyntaxKind.PrivateKeyword,
                  ts.SyntaxKind.ProtectedKeyword,
                  ts.SyntaxKind.ReadonlyKeyword,
                ].includes(modifier.kind),
              )
            ) {
              continue;
            }
            instance.members.set(
              parameter.name.text,
              cloneValue(argumentValues[index] ?? undefinedValue()),
            );
            instance.knownDefinedMembers.add(parameter.name.text);
          }
        }
        const returned = constructor
          ? invokeFunction(
              {
                environment: new Map(runtimeEnvironment(classState)),
                functionLike: constructor,
                thisValue: instance,
              },
              argumentValues,
              classState,
              instance,
            )
          : undefinedValue();
        classState.callStack = new Set(state.callStack);
        classState.environment = new Map(state.environment);
        classState.thisValue = state.thisValue;
        replaceState(state, classState);
        return mergeRuntimeValues(instance, returned);
      }
      const arrayValuesShareIdentity = (left, right) =>
        left.arrayIdentities.kind === 'known' &&
        right.arrayIdentities.kind === 'known' &&
        [...left.arrayIdentities.values].some((identity) =>
          right.arrayIdentities.values.has(identity),
        );
      const mutateArrayMembers = (value, argumentValues, methodName) => {
        const numericEntries = [...value.members]
          .filter(([memberName]) => exactArrayIndex(memberName) !== undefined)
          .sort(([left], [right]) => Number(left) - Number(right));
        if (methodName === 'unshift') {
          for (const [memberName] of [...numericEntries].reverse()) {
            const memberValue = value.members.get(memberName);
            value.members.delete(memberName);
            value.members.set(String(Number(memberName) + argumentValues.length), memberValue);
          }
          value.knownDefinedMembers = new Set(
            [...value.knownDefinedMembers].map((memberName) => {
              const index = exactArrayIndex(memberName);
              return index === undefined ? memberName : String(index + argumentValues.length);
            }),
          );
          argumentValues.forEach((argumentValue, index) => {
            value.members.set(String(index), cloneValue(argumentValue));
            value.knownDefinedMembers.add(String(index));
          });
          return;
        }
        let nextIndex = numericEntries.reduce(
          (highest, [memberName]) => Math.max(highest, Number(memberName) + 1),
          0,
        );
        for (const argumentValue of argumentValues) {
          value.members.set(String(nextIndex), cloneValue(argumentValue));
          value.knownDefinedMembers.add(String(nextIndex));
          nextIndex += 1;
        }
      };
      const applyArrayMutation = (owner, argumentValues, methodName, state) => {
        if (owner.arrayIdentities.kind === 'unknown') {
          invalidateReassignableBindings(state);
          return;
        }
        let updatedBinding = false;
        visitRuntimeValues(state, (value) => {
          if (!arrayValuesShareIdentity(owner, value)) return;
          mutateArrayMembers(value, argumentValues, methodName);
          updatedBinding = true;
        });
        if (!updatedBinding) mutateArrayMembers(owner, argumentValues, methodName);
      };
      const objectValuesShareIdentity = (left, right) =>
        [...(left.references ?? [])].some((identity) => right.references?.has(identity));
      const overwriteObjectMembers = (target, sources) => {
        for (const source of sources) {
          const sourceMembers = materializedMembers(source);
          if (sourceMembers.size === 0 && (source.references?.size ?? 0) === 0) {
            target.members.set('*', unknownCallableValue());
            target.knownDefinedMembers.clear();
            continue;
          }
          for (const [memberName, memberValue] of sourceMembers) {
            target.members.set(memberName, cloneValue(memberValue));
            if (memberName === '*') target.knownDefinedMembers.clear();
            else target.knownDefinedMembers.add(memberName);
          }
        }
        return target;
      };
      const applyObjectAssign = (target, sources, state) => {
        let updatedBinding = false;
        visitRuntimeValues(state, (value) => {
          if (!objectValuesShareIdentity(target, value)) return;
          overwriteObjectMembers(value, sources);
          updatedBinding = true;
        });
        if (!updatedBinding) overwriteObjectMembers(target, sources);
        return target;
      };
      function evaluateCall(current, state) {
        const mutation = arrayMutationForCall(current);
        if (mutation) {
          const owner = evaluateExpression(mutation.owner, state);
          const argumentValues = current.arguments.map((argument) =>
            evaluateExpression(argument, state),
          );
          applyArrayMutation(owner, argumentValues, mutation.methodName, state);
          return knownNonArrayValue(emptyCallableValue(), {
            nullish: MAY_BE_NON_NULLISH,
            truthiness: MAY_BE_TRUTHY | MAY_BE_FALSY,
          });
        }
        const callee = evaluateExpression(current.expression, state);
        const argumentValues = current.arguments.map((argument) =>
          evaluateExpression(argument, state),
        );
        if ((callee.kinds & CALLABLE_LOADER) !== 0) {
          recordContextualLoader(
            current,
            current.arguments[0],
            argumentValues[0],
            runtimeEnvironment(state),
            staticState(state),
          );
        }
        if (isObjectAssignCall(current)) {
          return applyObjectAssign(
            argumentValues[0] ?? undefinedValue(),
            argumentValues.slice(1),
            state,
          );
        }
        const results = [];
        if ((callee.kinds & CALLABLE_CREATE_REQUIRE) !== 0) {
          results.push(
            knownNonArrayValue({
              ...emptyCallableValue(),
              kinds: CALLABLE_LOADER,
            }),
          );
        }
        if (callee.functions.length > 0) {
          const branches = callee.functions.map((record) => {
            const branchState = cloneState(state);
            return {
              state: branchState,
              value: invokeFunction(record, argumentValues, branchState, record.thisValue),
            };
          });
          replaceState(state, mergeStates(branches.map((branch) => branch.state)));
          results.push(...branches.map((branch) => branch.value));
        }
        if (results.length > 0) return mergeRuntimeValues(...results);
        invalidateReassignableBindings(state);
        return unknownCallableValue();
      }
      function evaluateLogicalAssignment(current, state) {
        const token = current.operatorToken.kind;
        const logicalKind =
          token === ts.SyntaxKind.AmpersandAmpersandEqualsToken
            ? ts.SyntaxKind.AmpersandAmpersandToken
            : token === ts.SyntaxKind.BarBarEqualsToken
              ? ts.SyntaxKind.BarBarToken
              : ts.SyntaxKind.QuestionQuestionToken;
        const left = evaluateExpression(current.left, state);
        const reachability = logicalReachability(left, logicalKind);
        const branches = [];
        if (reachability.left) branches.push({ state: cloneState(state), value: left });
        if (reachability.right) {
          const rightState = cloneState(state);
          const right = evaluateExpression(current.right, rightState);
          bindPattern(current.left, right, rightState, current.right);
          branches.push({ state: rightState, value: right });
        }
        return branches.length > 0
          ? mergeExpressionBranches(state, branches)
          : unknownCallableValue();
      }
      function evaluateExpression(valueExpression, state) {
        const current = unwrapExpression(valueExpression);
        const value = evaluateExpressionValue(current, state);
        if (current === targetExpression) targetValues.push(cloneValue(value));
        return value;
      }
      function evaluateExpressionValue(valueExpression, state) {
        const current = unwrapExpression(valueExpression);
        if (current.kind === ts.SyntaxKind.NullKeyword) return undefinedValue();
        if (current.kind === ts.SyntaxKind.TrueKeyword) return booleanValue(MAY_BE_TRUTHY);
        if (current.kind === ts.SyntaxKind.FalseKeyword) return booleanValue(MAY_BE_FALSY);
        if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
          return knownNonArrayValue(
            {
              ...emptyCallableValue(),
              strings: new Set([current.text]),
            },
            {
              nullish: MAY_BE_NON_NULLISH,
              truthiness: current.text.length === 0 ? MAY_BE_FALSY : MAY_BE_TRUTHY,
            },
          );
        }
        if (ts.isNumericLiteral(current)) {
          return knownNonArrayValue(
            {
              ...emptyCallableValue(),
              strings: new Set([current.text]),
            },
            {
              nullish: MAY_BE_NON_NULLISH,
              truthiness: Number(current.text) === 0 ? MAY_BE_FALSY : MAY_BE_TRUTHY,
            },
          );
        }
        if (ts.isIdentifier(current)) {
          if (current.text === 'undefined' && isUnshadowedIdentifier(current, 'undefined')) {
            return undefinedValue();
          }
          if (isUnshadowedIdentifier(current, 'require')) {
            return knownNonArrayValue({
              ...emptyCallableValue(),
              kinds: CALLABLE_LOADER,
              nullish: MAY_BE_NON_NULLISH,
              truthiness: MAY_BE_TRUTHY,
            });
          }
          const identity = valueSymbolIdentity(current);
          if (identity && state.bindings.has(identity))
            return cloneValue(state.bindings.get(identity));
          return withRuntimeFacts(
            callableValueForSymbol(
              symbolAt(checker, current),
              runtimeEnvironment(state),
              staticState(state),
            ),
            current,
            state,
          );
        }
        if (current.kind === ts.SyntaxKind.ThisKeyword) {
          return state.thisValue ?? unknownCallableValue();
        }
        if (isModuleRequire(current)) {
          return knownNonArrayValue({
            ...emptyCallableValue(),
            kinds: CALLABLE_LOADER,
            nullish: MAY_BE_NON_NULLISH,
            truthiness: MAY_BE_TRUTHY,
          });
        }
        if (ts.isArrayLiteralExpression(current)) return evaluateArrayLiteral(current, state);
        if (ts.isObjectLiteralExpression(current)) return evaluateObjectLiteral(current, state);
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          return evaluatePropertyAccess(current, state);
        }
        if (ts.isCallExpression(current)) return evaluateCall(current, state);
        if (ts.isConditionalExpression(current)) {
          const condition = evaluateExpression(current.condition, state);
          const branches = [];
          if ((condition.truthiness & MAY_BE_TRUTHY) !== 0) {
            const branchState = cloneState(state);
            branches.push({
              state: branchState,
              value: evaluateExpression(current.whenTrue, branchState),
            });
          }
          if ((condition.truthiness & MAY_BE_FALSY) !== 0) {
            const branchState = cloneState(state);
            branches.push({
              state: branchState,
              value: evaluateExpression(current.whenFalse, branchState),
            });
          }
          return branches.length > 0
            ? mergeExpressionBranches(state, branches)
            : unknownCallableValue();
        }
        if (ts.isBinaryExpression(current)) {
          const token = current.operatorToken.kind;
          if (token === ts.SyntaxKind.CommaToken) {
            evaluateExpression(current.left, state);
            return evaluateExpression(current.right, state);
          }
          if (isLogicalOperator(token)) {
            const left = evaluateExpression(current.left, state);
            const reachability = logicalReachability(left, token);
            const branches = [];
            if (reachability.left) branches.push({ state: cloneState(state), value: left });
            if (reachability.right) {
              const branchState = cloneState(state);
              branches.push({
                state: branchState,
                value: evaluateExpression(current.right, branchState),
              });
            }
            return branches.length > 0
              ? mergeExpressionBranches(state, branches)
              : unknownCallableValue();
          }
          if (token === ts.SyntaxKind.EqualsToken) {
            const right = evaluateExpression(current.right, state);
            bindPattern(current.left, right, state, current.right);
            return right;
          }
          if (
            token === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
            token === ts.SyntaxKind.BarBarEqualsToken ||
            token === ts.SyntaxKind.QuestionQuestionEqualsToken
          ) {
            return evaluateLogicalAssignment(current, state);
          }
          evaluateExpression(current.left, state);
          evaluateExpression(current.right, state);
          return withRuntimeFacts(
            callableValue(current, runtimeEnvironment(state), staticState(state)),
            current,
            state,
          );
        }
        if (ts.isAwaitExpression(current)) return evaluateExpression(current.expression, state);
        if (ts.isPrefixUnaryExpression(current)) {
          const operand = evaluateExpression(current.operand, state);
          if (current.operator === ts.SyntaxKind.ExclamationToken) {
            let truthiness = 0;
            if ((operand.truthiness & MAY_BE_TRUTHY) !== 0) truthiness |= MAY_BE_FALSY;
            if ((operand.truthiness & MAY_BE_FALSY) !== 0) truthiness |= MAY_BE_TRUTHY;
            return booleanValue(truthiness);
          }
          return knownNonArrayValue(emptyCallableValue(), {
            nullish: MAY_BE_NON_NULLISH,
            truthiness: MAY_BE_TRUTHY | MAY_BE_FALSY,
          });
        }
        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
          return knownNonArrayValue({
            ...emptyCallableValue(),
            functions: [
              {
                environment: new Map(runtimeEnvironment(state)),
                functionLike: current,
              },
            ],
            nullish: MAY_BE_NON_NULLISH,
            truthiness: MAY_BE_TRUTHY,
          });
        }
        if (ts.isClassExpression(current)) {
          return knownNonArrayValue(
            classCallableValue(current, runtimeEnvironment(state), staticState(state)),
            { nullish: MAY_BE_NON_NULLISH, truthiness: MAY_BE_TRUTHY },
          );
        }
        if (ts.isNewExpression(current)) {
          const constructorValue = evaluateExpression(current.expression, state);
          const argumentValues = (current.arguments ?? []).map((argument) =>
            evaluateExpression(argument, state),
          );
          if (constructorValue.constructors.length > 0) {
            const branches = constructorValue.constructors.map((record) => {
              const branchState = cloneState(state);
              return {
                state: branchState,
                value: constructRuntimeValue(record, argumentValues, branchState, current),
              };
            });
            replaceState(state, mergeStates(branches.map((branch) => branch.state)));
            return mergeRuntimeValues(...branches.map((branch) => branch.value));
          }
          invalidateReassignableBindings(state);
          return {
            ...unknownCallableValue(),
            nullish: MAY_BE_NON_NULLISH,
            truthiness: MAY_BE_TRUTHY,
          };
        }
        ts.forEachChild(current, (child) => {
          if (ts.isExpression(child)) evaluateExpression(child, state);
        });
        invalidateReassignableBindings(state);
        return unknownCallableValue();
      }
      function evaluateStatement(statement, state) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const value = declaration.initializer
              ? evaluateExpression(declaration.initializer, state)
              : unknownCallableValue();
            bindPattern(declaration.name, value, state, declaration.initializer);
          }
          return [{ completion: 'normal', state }];
        }
        if (ts.isExpressionStatement(statement)) {
          evaluateExpression(statement.expression, state);
          return [{ completion: 'normal', state }];
        }
        if (ts.isReturnStatement(statement)) {
          return [
            {
              completion: 'return',
              state,
              value: statement.expression
                ? evaluateExpression(statement.expression, state)
                : undefinedValue(),
            },
          ];
        }
        if (ts.isBreakStatement(statement)) {
          return [{ completion: 'break', state }];
        }
        if (ts.isBlock(statement)) {
          return evaluateStatementList(statement.statements, [{ completion: 'normal', state }]);
        }
        if (ts.isIfStatement(statement)) {
          const condition = evaluateExpression(statement.expression, state);
          const outcomes = [];
          if ((condition.truthiness & MAY_BE_TRUTHY) !== 0) {
            outcomes.push(...evaluateStatement(statement.thenStatement, cloneState(state)));
          }
          if ((condition.truthiness & MAY_BE_FALSY) !== 0) {
            outcomes.push(
              ...(statement.elseStatement
                ? evaluateStatement(statement.elseStatement, cloneState(state))
                : [{ completion: 'normal', state: cloneState(state) }]),
            );
          }
          return outcomes;
        }
        if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
          const outcomes = [];
          const evaluateIteration = (iterationState) => {
            for (const outcome of evaluateStatement(statement.statement, iterationState)) {
              if (outcome.completion === 'return') {
                outcomes.push(outcome);
              } else if (outcome.completion === 'break') {
                outcomes.push({ completion: 'normal', state: outcome.state });
              } else {
                outcomes.push({ completion: 'normal', state: outcome.state });
              }
            }
          };
          if (ts.isDoStatement(statement)) {
            const firstIteration = evaluateStatement(statement.statement, state);
            for (const outcome of firstIteration) {
              if (outcome.completion === 'return') {
                outcomes.push(outcome);
                continue;
              }
              if (outcome.completion === 'break') {
                outcomes.push({ completion: 'normal', state: outcome.state });
                continue;
              }
              const condition = evaluateExpression(statement.expression, outcome.state);
              if ((condition.truthiness & MAY_BE_FALSY) !== 0) {
                outcomes.push({ completion: 'normal', state: cloneState(outcome.state) });
              }
              if ((condition.truthiness & MAY_BE_TRUTHY) !== 0) {
                evaluateIteration(cloneState(outcome.state));
              }
            }
            return outcomes;
          }
          const condition = evaluateExpression(statement.expression, state);
          if ((condition.truthiness & MAY_BE_FALSY) !== 0) {
            outcomes.push({ completion: 'normal', state: cloneState(state) });
          }
          if ((condition.truthiness & MAY_BE_TRUTHY) !== 0) {
            evaluateIteration(cloneState(state));
          }
          return outcomes;
        }
        if (ts.isSwitchStatement(statement)) {
          evaluateExpression(statement.expression, state);
          const clauses = [...statement.caseBlock.clauses];
          const switchKey = literalSwitchKey(statement.expression);
          const defaultIndex = clauses.findIndex((clause) => ts.isDefaultClause(clause));
          const evaluateCasesThrough = (endIndex, branchState) => {
            for (let index = 0; index <= endIndex; index += 1) {
              const clause = clauses[index];
              if (ts.isCaseClause(clause)) evaluateExpression(clause.expression, branchState);
            }
          };
          const evaluateFrom = (startIndex, branchState) => {
            const clauseStatements = clauses
              .slice(startIndex)
              .flatMap((clause) => [...clause.statements]);
            return evaluateStatementList(clauseStatements, [
              { completion: 'normal', state: branchState },
            ]).map((outcome) =>
              outcome.completion === 'break'
                ? { completion: 'normal', state: outcome.state }
                : outcome,
            );
          };
          if (switchKey !== undefined) {
            let selectedIndex = -1;
            for (const [index, clause] of clauses.entries()) {
              if (!ts.isCaseClause(clause)) continue;
              evaluateExpression(clause.expression, state);
              if (literalSwitchKey(clause.expression) === switchKey) {
                selectedIndex = index;
                break;
              }
            }
            if (selectedIndex < 0) selectedIndex = defaultIndex;
            return selectedIndex < 0
              ? [{ completion: 'normal', state }]
              : evaluateFrom(selectedIndex, state);
          }
          const outcomes = [];
          for (const [index, clause] of clauses.entries()) {
            if (!ts.isCaseClause(clause)) continue;
            const branchState = cloneState(state);
            evaluateCasesThrough(index, branchState);
            outcomes.push(...evaluateFrom(index, branchState));
          }
          const defaultState = cloneState(state);
          evaluateCasesThrough(clauses.length - 1, defaultState);
          outcomes.push(
            ...(defaultIndex < 0
              ? [{ completion: 'normal', state: defaultState }]
              : evaluateFrom(defaultIndex, defaultState)),
          );
          return outcomes;
        }
        if (
          ts.isExportDeclaration(statement) ||
          ts.isImportDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEmptyStatement(statement)
        ) {
          return [{ completion: 'normal', state }];
        }
        if (ts.isThrowStatement(statement)) {
          if (statement.expression) evaluateExpression(statement.expression, state);
          return [];
        }
        invalidateReassignableBindings(state);
        return [{ completion: 'normal', state }];
      }
      function evaluateStatementList(statements, initialOutcomes) {
        let outcomes = initialOutcomes;
        for (const statement of statements) {
          const completed = outcomes.filter((outcome) => outcome.completion !== 'normal');
          const continuing = outcomes.filter((outcome) => outcome.completion === 'normal');
          if (continuing.length === 0) return completed;
          outcomes = [
            ...completed,
            ...continuing.flatMap((outcome) => evaluateStatement(statement, outcome.state)),
          ];
        }
        return outcomes;
      }

      const statements = [...scope.statements];
      const targetStatementIndex = statements.indexOf(scope.statement);
      const cachePrelude = collectLoaderContexts && ts.isSourceFile(scope.statement.parent);
      let startIndex = 0;
      let initialState = createState();
      if (cachePrelude) {
        for (let index = targetStatementIndex; index >= 0; index -= 1) {
          const cachedState = sourceOrderedPreludeStateCache.get(statements[index]);
          if (!cachedState) continue;
          initialState = cloneState(cachedState);
          startIndex = index;
          break;
        }
        if (targetStatementIndex >= 0 && !sourceOrderedPreludeStateCache.has(statements[0])) {
          sourceOrderedPreludeStateCache.set(statements[0], cloneState(initialState));
        }
      }
      let outcomes = [{ completion: 'normal', state: initialState }];
      for (let index = startIndex; index < targetStatementIndex; index += 1) {
        const statement = statements[index];
        outcomes = evaluateStatementList([statement], outcomes);
        const continuing = outcomes.filter((outcome) => outcome.completion === 'normal');
        if (continuing.length === 0) {
          const result = unknownCallableValue();
          sourceOrderedEvaluationCache.set(contextNode, result);
          return result;
        }
        outcomes = [
          { completion: 'normal', state: mergeStates(continuing.map((item) => item.state)) },
        ];
        if (cachePrelude) {
          sourceOrderedPreludeStateCache.set(statements[index + 1], cloneState(outcomes[0].state));
        }
      }
      const targetOutcomes = evaluateStatement(scope.statement, outcomes[0].state);
      const continuing = targetOutcomes.filter((outcome) => outcome.completion === 'normal');
      if (cachePrelude && continuing.length > 0 && statements[targetStatementIndex + 1]) {
        sourceOrderedPreludeStateCache.set(
          statements[targetStatementIndex + 1],
          mergeStates(continuing.map((outcome) => outcome.state)),
        );
      }
      const result =
        targetValues.length > 0
          ? mergeRuntimeValues(...targetValues)
          : knownNonArrayValue(emptyCallableValue(), {
              nullish: MAY_BE_NON_NULLISH,
              truthiness: MAY_BE_FALSY,
            });
      sourceOrderedEvaluationCache.set(contextNode, result);
      return result;
    } finally {
      sourceOrderedEvaluationStack.delete(contextNode);
    }
  }

  function sourceOrderedArrayMutationTargets(contextNode, expression) {
    const value = sourceOrderedArrayMutationValue(contextNode, expression);
    return value?.arrayIdentities.kind === 'known' && value.arrayIdentities.values.size > 0
      ? new Set(value.arrayIdentities.values)
      : undefined;
  }

  function addArrayMutationProvenance(callExpression) {
    const mutation = arrayMutationForCall(callExpression);
    if (!mutation) return false;
    const argumentProvenance = callExpression.arguments.map((argument) => ({
      functionTargets: functionTargetsForExpression(argument),
      kinds: callableKinds(argument),
      references: referenceSymbolsForExpression(argument),
    }));
    const referencesCarryCallable = (references, seen = new Set()) => {
      for (const reference of references) {
        if (seen.has(reference)) continue;
        seen.add(reference);
        if (
          [...memberMapForSymbol(callableMembersBySymbol, reference).values()].some(
            (kinds) => kinds !== 0,
          ) ||
          [...memberSetMapForSymbol(functionMembersBySymbol, reference).values()].some(
            (targets) => targets.size > 0,
          )
        ) {
          return true;
        }
        const nestedReferences = union(
          ...memberSetMapForSymbol(memberReferencesBySymbol, reference).values(),
        );
        if (referencesCarryCallable(nestedReferences, seen)) return true;
      }
      return false;
    };
    const carriesCallable = argumentProvenance.some(
      (value) =>
        value.kinds !== 0 ||
        value.functionTargets.size > 0 ||
        referencesCarryCallable(value.references),
    );
    if (!carriesCallable) return false;
    const receiver = sourceOrderedArrayMutationValue(callExpression, mutation.owner);
    if (!receiver.arrayLike) return false;
    if (receiver.arrayIdentities.kind === 'unknown') {
      unresolvedLoaderExpressions.set(callExpression, callExpression.getSourceFile());
      return false;
    }
    let changed = false;
    for (const target of receiver.arrayIdentities.values) {
      for (const argument of argumentProvenance) {
        changed = addMemberKinds(target, new Set(['*']), argument.kinds) || changed;
        changed =
          addMemberFunctionTargets(target, new Set(['*']), argument.functionTargets) || changed;
        changed = addMemberReferences(target, new Set(['*']), argument.references) || changed;
      }
    }
    return changed;
  }

  function addObjectAssignProvenance(callExpression) {
    if (!isObjectAssignCall(callExpression) || callExpression.arguments.length === 0) return false;
    let changed = false;
    for (const target of objectMutationTargetSymbols(callExpression.arguments[0])) {
      for (const source of callExpression.arguments.slice(1)) {
        changed = addContainerProvenance(target, source) || changed;
      }
    }
    return changed;
  }

  visitSourceFiles(sourceFiles, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      (!ts.isObjectLiteralExpression(unwrapExpression(node.left)) &&
        !ts.isArrayLiteralExpression(unwrapExpression(node.left)))
    ) {
      return;
    }
    const symbols = new Set();
    collectAssignmentSymbols(node.left, symbols);
    for (const symbol of symbols) {
      const identity = aliasedSymbol(checker, symbol) ?? symbol;
      const records = destructuringAssignmentsBySymbol.get(identity) ?? [];
      records.push({ expression: node.right, pattern: node.left });
      destructuringAssignmentsBySymbol.set(identity, records);
    }
  });

  let callableChanged = true;
  while (callableChanged) {
    callableChanged = false;
    visitSourceFiles(sourceFiles, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isNodeModuleNamespaceValue(node.initializer)
      ) {
        callableChanged = addNodeModuleNamespaceIdentifier(node.name) || callableChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.left)) &&
        isNodeModuleNamespaceValue(node.right)
      ) {
        callableChanged =
          addNodeModuleNamespaceIdentifier(unwrapExpression(node.left)) || callableChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isNodeModuleNamespaceValue(node.initializer)
      ) {
        callableChanged = addCreateRequireDestructuredFactories(node.name) || callableChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isNodeModuleNamespaceValue(node.right)
      ) {
        callableChanged = addCreateRequireDestructuredFactories(node.left) || callableChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(unwrapExpression(node.initializer)) &&
        isUnshadowedIdentifier(unwrapExpression(node.initializer), 'module')
      ) {
        callableChanged = addModuleDestructuredLoaders(node.name) || callableChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.right)) &&
        isUnshadowedIdentifier(unwrapExpression(node.right), 'module')
      ) {
        callableChanged = addModuleDestructuredLoaders(node.left) || callableChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(unwrapExpression(node.initializer)) &&
        isUnshadowedIdentifier(unwrapExpression(node.initializer), 'Object')
      ) {
        callableChanged = addObjectAssignDestructuredAliases(node.name) || callableChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.right)) &&
        isUnshadowedIdentifier(unwrapExpression(node.right), 'Object')
      ) {
        callableChanged = addObjectAssignDestructuredAliases(node.left) || callableChanged;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isFunctionPrototypeExpression(node.initializer)
      ) {
        callableChanged = addIntrinsicInvocationDestructuredAliases(node.name) || callableChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isFunctionPrototypeExpression(node.right)
      ) {
        callableChanged = addIntrinsicInvocationDestructuredAliases(node.left) || callableChanged;
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        callableChanged =
          addFunctionTargets(symbolAt(checker, node.name), new Set([node])) || callableChanged;
      } else if (ts.isMethodDeclaration(node) && node.name) {
        callableChanged =
          addFunctionTargets(symbolAt(checker, node.name), new Set([node])) || callableChanged;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const symbol = symbolAt(checker, node.name);
        callableChanged =
          addCallableKinds(symbol, callableKinds(node.initializer)) || callableChanged;
        callableChanged =
          addFunctionTargets(symbol, functionTargetsForExpression(node.initializer)) ||
          callableChanged;
        callableChanged = addContainerProvenance(symbol, node.initializer) || callableChanged;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        !isDestructuringAssignmentDefault(node)
      ) {
        const functionTargets = functionTargetsForExpression(node.right);
        callableChanged =
          addAssignmentCallableProvenance(
            node.left,
            callableKinds(node.right),
            functionTargets,
            referenceSymbolsForExpression(node.right),
          ) || callableChanged;
        if (ts.isIdentifier(unwrapExpression(node.left))) {
          callableChanged =
            addContainerProvenance(symbolAt(checker, unwrapExpression(node.left)), node.right) ||
            callableChanged;
        }
      } else if (ts.isPropertyAssignment(node)) {
        callableChanged =
          addCallableKinds(symbolAt(checker, node.name), callableKinds(node.initializer)) ||
          callableChanged;
        callableChanged =
          addFunctionTargets(
            symbolAt(checker, node.name),
            functionTargetsForExpression(node.initializer),
          ) || callableChanged;
      }
      if (ts.isFunctionLike(node) && node.body) {
        callableChanged =
          addFunctionReturnKinds(node, functionReturnKinds(node)) || callableChanged;
      }
      if (ts.isCallExpression(node)) {
        callableChanged = addArrayMutationProvenance(node) || callableChanged;
        callableChanged = addObjectAssignProvenance(node) || callableChanged;
      }
    });
  }

  const loaderRelevantSourceFiles = new Set();
  visitSourceFiles(sourceFiles, (node, sourceFile) => {
    if (
      (ts.isIdentifier(node) &&
        (isUnshadowedIdentifier(node, 'require') ||
          (callableKindsForSymbol(symbolAt(checker, node)) &
            (CALLABLE_LOADER | CALLABLE_CREATE_REQUIRE)) !==
            0)) ||
      isModuleRequire(node) ||
      ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(unwrapExpression(node.expression)) &&
        nodeModuleNamespaceSymbols.has(symbolAt(checker, unwrapExpression(node.expression))))
    ) {
      loaderRelevantSourceFiles.add(sourceFile);
    }
  });
  let loaderReachabilityChanged = true;
  while (loaderReachabilityChanged) {
    loaderReachabilityChanged = false;
    for (const record of localImportRecords) {
      const targetSourceFile = resolveLocalSourceFile(record.sourceFile, record.moduleSpecifier);
      if (
        targetSourceFile &&
        loaderRelevantSourceFiles.has(targetSourceFile) &&
        !loaderRelevantSourceFiles.has(record.sourceFile)
      ) {
        loaderRelevantSourceFiles.add(record.sourceFile);
        loaderReachabilityChanged = true;
      }
    }
  }
  collectLoaderContexts = true;
  visitSourceFiles(sourceFiles, (node, sourceFile) => {
    if (loaderRelevantSourceFiles.has(sourceFile) && ts.isCallExpression(node)) {
      callableValue(node);
    }
  });
  collectLoaderContexts = false;

  for (const [node, sourceFile] of unresolvedLoaderExpressions) {
    addImport(sourceFile, `unresolved-loader:${lineAndColumn(sourceFile, node)}`);
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
    const contextRecords = dynamicImport
      ? [node.arguments[0] ? staticTargets(node.arguments[0]) : undefined]
      : [...(contextualLoaderTargets.get(node)?.values() ?? [])];
    if (contextRecords.length === 0) return;
    const targets = union(...contextRecords.filter((record) => record !== undefined));
    if (contextRecords.some((record) => record === undefined)) {
      const detail = `unresolved-loader:${lineAndColumn(sourceFile, node)}`;
      addImport(sourceFile, detail);
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
