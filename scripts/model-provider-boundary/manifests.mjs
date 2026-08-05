import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const AI_SDK_NON_PROVIDER_PACKAGES = new Set([
  '@ai-sdk/mcp',
  '@ai-sdk/provider',
  '@ai-sdk/provider-utils',
]);

// Exact package names for first-party model-provider SDKs that do not use the
// AI SDK naming convention. A package only becomes an alias source after it is
// found in a tracked manifest; this list is not a substring heuristic.
const OFFICIAL_PROVIDER_PACKAGES = new Set([
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/sdk',
  '@aws-sdk/client-bedrock-runtime',
  '@azure-rest/ai-inference',
  '@azure/openai',
  '@google-cloud/vertexai',
  '@google/generative-ai',
  '@google/genai',
  '@huggingface/inference',
  '@mistralai/mistralai',
  '@openrouter/ai-sdk-provider',
  '@xai-sdk/client',
  'cohere-ai',
  'groq-sdk',
  'mistralai',
  'ollama',
  'openai',
  'replicate',
  'together-ai',
]);

function packageRoot(moduleName) {
  const segments = moduleName.split('/');
  return moduleName.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function npmAliasTarget(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('npm:')) {
    return undefined;
  }
  const target = specifier.slice(4);
  if (target.startsWith('@')) {
    const separator = target.indexOf('@', target.indexOf('/') + 1);
    return separator < 0 ? target : target.slice(0, separator);
  }
  const separator = target.indexOf('@');
  return separator < 0 ? target : target.slice(0, separator);
}

function isProviderPackageRoot(packageName) {
  if (packageName.startsWith('@ai-sdk/')) {
    return !AI_SDK_NON_PROVIDER_PACKAGES.has(packageName);
  }
  return OFFICIAL_PROVIDER_PACKAGES.has(packageName);
}

function collectImportTargets(value, targets = []) {
  if (typeof value === 'string') {
    targets.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectImportTargets(entry, targets);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectImportTargets(entry, targets);
  }
  return targets;
}

function packageDirectory(relativeManifestPath) {
  const directory = path.posix.dirname(relativeManifestPath);
  return directory === '.' ? '' : directory;
}

async function manifestText(entry) {
  return entry.text ?? readFile(entry.absolutePath, 'utf8');
}

export async function buildForbiddenModuleMap(manifests) {
  const modules = new Map([['ai', 'ai']]);
  const packageImports = [];
  for (const entry of manifests) {
    const manifest = JSON.parse(await manifestText(entry));
    const directory = packageDirectory(entry.relativePath);
    packageImports.push({
      directory,
      imports:
        manifest.imports && typeof manifest.imports === 'object' && !Array.isArray(manifest.imports)
          ? manifest.imports
          : {},
    });
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        continue;
      }
      for (const [dependencyName, version] of Object.entries(dependencies)) {
        const targetName = npmAliasTarget(version) ?? dependencyName;
        const targetRoot = packageRoot(targetName);
        if (targetRoot === 'ai' || isProviderPackageRoot(targetRoot)) {
          modules.set(dependencyName, targetRoot);
          modules.set(targetRoot, targetRoot);
        }
      }
    }
  }
  packageImports.sort((left, right) => right.directory.length - left.directory.length);
  return { modules, packageImports };
}

function importsMatch(specifier, key) {
  if (key === specifier) return { capture: '' };
  const star = key.indexOf('*');
  if (star < 0 || key.indexOf('*', star + 1) >= 0) return undefined;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return { capture: specifier.slice(prefix.length, specifier.length - suffix.length) };
}

function containingPackage(policy, relativeSourcePath) {
  return policy.packageImports.find(
    ({ directory }) =>
      directory === '' ||
      relativeSourcePath === directory ||
      relativeSourcePath.startsWith(`${directory}/`),
  );
}

export function resolvePackageImportTargets(moduleName, policy, relativeSourcePath) {
  if (!moduleName.startsWith('#')) return [];
  const packageEntry = containingPackage(policy, relativeSourcePath);
  if (!packageEntry) return [];

  const matches = [];
  for (const [key, value] of Object.entries(packageEntry.imports)) {
    const match = importsMatch(moduleName, key);
    if (!match) continue;
    for (const target of collectImportTargets(value)) {
      matches.push({
        packageDirectory: packageEntry.directory,
        target: target.replaceAll('*', match.capture),
      });
    }
    if (key === moduleName) break;
  }
  return matches;
}

function resolveDirectForbiddenModule(moduleName, modules) {
  const requestedRoot = packageRoot(moduleName);
  if (requestedRoot === 'ai') return 'ai';
  if (requestedRoot.startsWith('@ai-sdk/') && isProviderPackageRoot(requestedRoot)) {
    return moduleName;
  }
  if (OFFICIAL_PROVIDER_PACKAGES.has(requestedRoot)) return moduleName;
  const canonicalRoot = modules.get(requestedRoot);
  if (!canonicalRoot) return undefined;
  return `${canonicalRoot}${moduleName.slice(requestedRoot.length)}`;
}

export function resolveForbiddenModule(moduleName, policy, relativeSourcePath = '') {
  const direct = resolveDirectForbiddenModule(moduleName, policy.modules);
  if (direct) return direct;
  for (const { target } of resolvePackageImportTargets(moduleName, policy, relativeSourcePath)) {
    const aliasTarget = npmAliasTarget(target) ?? target;
    const resolved = resolveDirectForbiddenModule(aliasTarget, policy.modules);
    if (resolved) return resolved;
  }
  return undefined;
}

export const manifestInternalsForTests = {
  collectImportTargets,
  npmAliasTarget,
  packageRoot,
};
