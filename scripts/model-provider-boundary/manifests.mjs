import { readFile } from 'node:fs/promises';

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

export async function buildForbiddenModuleMap(manifests) {
  const forbiddenModules = new Map([['ai', 'ai']]);
  for (const { absolutePath } of manifests) {
    const manifest = JSON.parse(await readFile(absolutePath, 'utf8'));
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        continue;
      }
      for (const [dependencyName, version] of Object.entries(dependencies)) {
        const targetName = npmAliasTarget(version) ?? dependencyName;
        const targetRoot = packageRoot(targetName);
        if (targetRoot === 'ai' || isProviderPackageRoot(targetRoot)) {
          forbiddenModules.set(dependencyName, targetRoot);
          forbiddenModules.set(targetRoot, targetRoot);
        }
      }
    }
  }
  return forbiddenModules;
}

export function resolveForbiddenModule(moduleName, forbiddenModules) {
  const requestedRoot = packageRoot(moduleName);
  if (requestedRoot === 'ai') {
    return 'ai';
  }
  if (requestedRoot.startsWith('@ai-sdk/') && isProviderPackageRoot(requestedRoot)) {
    return moduleName;
  }
  if (OFFICIAL_PROVIDER_PACKAGES.has(requestedRoot)) {
    return moduleName;
  }
  const canonicalRoot = forbiddenModules.get(requestedRoot);
  if (!canonicalRoot) {
    return undefined;
  }
  const suffix = moduleName.slice(requestedRoot.length);
  return `${canonicalRoot}${suffix}`;
}

export const manifestInternalsForTests = {
  npmAliasTarget,
  packageRoot,
};
