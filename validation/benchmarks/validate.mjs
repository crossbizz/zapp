import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCHMARK_CATEGORIES = [
  'react-vite-crud',
  'next-saas',
  'existing-imported-project',
  'monorepo',
  'supabase-auth',
  'neon-backed',
  'stripe-subscription',
  'intentional-regressions',
  'migration-risk',
  'production-only-error',
];

const REQUIRED_PROTOCOL_FIELDS = [
  'deliberateDefect',
  'sharedComponentChange',
  'schemaChange',
  'dependencyUpgrade',
  'rollback',
  'syntheticProductionFailure',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, field) {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    `${field} must be a non-empty string`,
  );
}

function repositoryPath(repositoryRoot, relativePath, field) {
  nonEmptyString(relativePath, field);
  invariant(
    !path.isAbsolute(relativePath) &&
      relativePath.split(/[\\/]/u).every((segment) => segment !== '..'),
    `${field} must be repository-relative`,
  );
  const resolved = path.resolve(repositoryRoot, relativePath);
  invariant(
    resolved.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`),
    `${field} must be repository-relative`,
  );
  return resolved;
}

async function canonicalRepositoryPath(repositoryRoot, candidate, field) {
  const canonicalRoot = await realpath(repositoryRoot);
  const canonicalCandidate = await realpath(candidate);
  invariant(
    canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`),
    `${field} must resolve inside the repository`,
  );
  return canonicalCandidate;
}

async function assertSafeSeedTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    invariant(!entry.isSymbolicLink(), `benchmark seed contains a symbolic link: ${child}`);
    invariant(
      entry.name !== 'node_modules' && entry.name !== '.git',
      `benchmark seed contains generated or repository metadata: ${child}`,
    );
    if (entry.isDirectory()) {
      await assertSafeSeedTree(child);
    } else if (/^\.env(?:\.|$)/u.test(entry.name) && entry.name !== '.env.example') {
      throw new Error(`benchmark seed contains a committed environment file: ${child}`);
    }
  }
}

export async function loadBenchmarkManifest(repositoryRoot) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, 'validation', 'benchmarks', 'manifest.json'), 'utf8'),
  );
}

export async function validateBenchmarkManifest(manifest, repositoryRoot) {
  invariant(manifest?.schemaVersion === 1, 'benchmark schemaVersion must be 1');
  invariant(manifest?.protocol === 'PRD-40.2-40.3', 'benchmark protocol must be PRD-40.2-40.3');
  invariant(Array.isArray(manifest?.apps), 'benchmark apps must be an array');
  invariant(manifest.apps.length === 10, 'benchmark suite must contain exactly 10 apps');

  const ids = new Set();
  const categories = [];
  let featureChanges = 0;
  for (const [index, app] of manifest.apps.entries()) {
    const prefix = `apps[${index}]`;
    nonEmptyString(app?.id, `${prefix}.id`);
    invariant(!ids.has(app.id), `benchmark id must be unique: ${app.id}`);
    ids.add(app.id);
    categories.push(app.category);
    invariant(app.mode === 'template' || app.mode === 'import', `${prefix}.mode is invalid`);
    nonEmptyString(app.name, `${prefix}.name`);
    invariant(
      Array.isArray(app.criticalFlows) && app.criticalFlows.length > 0,
      `${prefix}.criticalFlows must not be empty`,
    );
    for (const [flowIndex, flow] of app.criticalFlows.entries()) {
      nonEmptyString(flow, `${prefix}.criticalFlows[${flowIndex}]`);
    }
    invariant(
      Array.isArray(app.featureChanges) && app.featureChanges.length === 5,
      `${prefix}.featureChanges must contain exactly five changes`,
    );
    invariant(new Set(app.featureChanges).size === 5, `${prefix}.featureChanges must be unique`);
    for (const [changeIndex, change] of app.featureChanges.entries()) {
      nonEmptyString(change, `${prefix}.featureChanges[${changeIndex}]`);
    }
    featureChanges += app.featureChanges.length;
    for (const field of REQUIRED_PROTOCOL_FIELDS) {
      nonEmptyString(app[field], `${prefix}.${field}`);
    }

    const primarySeed = repositoryPath(repositoryRoot, app.primarySeed, `${prefix}.primarySeed`);
    await access(primarySeed);
    await canonicalRepositoryPath(repositoryRoot, primarySeed, `${prefix}.primarySeed`);
    const packageJson = JSON.parse(await readFile(path.join(primarySeed, 'package.json'), 'utf8'));
    invariant(
      typeof packageJson?.scripts?.build === 'string',
      `${prefix}.primarySeed must provide a build script`,
    );
    await assertSafeSeedTree(primarySeed);

    invariant(
      Array.isArray(app.sourceEvidence) && app.sourceEvidence.length > 0,
      `${prefix}.sourceEvidence must not be empty`,
    );
    for (const [sourceIndex, source] of app.sourceEvidence.entries()) {
      const field = `${prefix}.sourceEvidence[${sourceIndex}]`;
      const evidence = repositoryPath(repositoryRoot, source, field);
      await access(evidence);
      await canonicalRepositoryPath(repositoryRoot, evidence, field);
    }
  }

  invariant(
    JSON.stringify([...categories].sort()) === JSON.stringify([...BENCHMARK_CATEGORIES].sort()),
    'benchmark categories must match PRD §40.2',
  );
  return { apps: manifest.apps.length, featureChanges };
}

async function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const result = await validateBenchmarkManifest(
    await loadBenchmarkManifest(repositoryRoot),
    repositoryRoot,
  );
  process.stdout.write(
    `benchmark suite valid: ${result.apps} apps, ${result.featureChanges} repeat changes\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
