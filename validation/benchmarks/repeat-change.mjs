import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_ENV = [
  'ZAPP_BENCHMARK_API_BASE_URL',
  'ZAPP_BENCHMARK_BEARER_TOKEN',
  'ZAPP_BENCHMARK_ORGANIZATION_ID',
];

export class BenchmarkPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BenchmarkPreflightError';
    this.code = code;
  }
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    const code = name === 'ZAPP_BENCHMARK_BEARER_TOKEN' ? 'missing_bearer_token' : 'missing_configuration';
    const target = name === 'ZAPP_BENCHMARK_BEARER_TOKEN'
      ? 'for the public /v1 API.'
      : 'before repeat-change execution.';
    throw new BenchmarkPreflightError(code, `${name} is required ${target}`);
  }
  return value.trim();
}

export function loadBenchmarkRunnerConfig(env = process.env) {
  for (const name of REQUIRED_ENV) requiredEnv(env, name);
  let apiBaseUrl;
  try {
    apiBaseUrl = new URL(env.ZAPP_BENCHMARK_API_BASE_URL);
  } catch {
    throw new BenchmarkPreflightError(
      'invalid_api_base_url',
      'ZAPP_BENCHMARK_API_BASE_URL must be an absolute http(s) URL.',
    );
  }
  if (!['http:', 'https:'].includes(apiBaseUrl.protocol) || apiBaseUrl.username || apiBaseUrl.password) {
    throw new BenchmarkPreflightError(
      'invalid_api_base_url',
      'ZAPP_BENCHMARK_API_BASE_URL must be an absolute http(s) URL.',
    );
  }
  return {
    apiBaseUrl: apiBaseUrl.toString(),
    bearerToken: env.ZAPP_BENCHMARK_BEARER_TOKEN.trim(),
    organizationId: env.ZAPP_BENCHMARK_ORGANIZATION_ID.trim(),
  };
}

function publicApiUrl(apiBaseUrl, path) {
  return new URL(path, apiBaseUrl).toString();
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Checks the actual public authentication and tenant-selection contract before
 * any paid or mutating benchmark operation. It intentionally never writes an
 * evidence artifact: a preflight is not an execution result.
 */
export async function preflightPublicApi(config, fetchImplementation = fetch) {
  const headers = {
    authorization: `Bearer ${config.bearerToken}`,
    'x-organization-id': config.organizationId,
  };
  let response;
  try {
    response = await fetchImplementation(publicApiUrl(config.apiBaseUrl, '/v1/me'), { headers });
  } catch {
    throw new BenchmarkPreflightError(
      'api_unreachable',
      'The public /v1 API could not be reached; no benchmark executions were started.',
    );
  }
  if (!response.ok) {
    throw new BenchmarkPreflightError(
      response.status === 401 ? 'unauthenticated' : 'api_rejected',
      response.status === 401
        ? 'The public /v1 API rejected the benchmark bearer credential; no benchmark executions were started.'
        : `The public /v1 API rejected benchmark preflight with HTTP ${String(response.status)}; no benchmark executions were started.`,
    );
  }
  const profile = await responseJson(response);
  const membership = profile?.memberships?.find(
    (entry) => entry?.organization?.id === config.organizationId && entry.status === 'active',
  );
  if (membership === undefined) {
    throw new BenchmarkPreflightError(
      'organization_not_active',
      'The benchmark credential has no active membership for ZAPP_BENCHMARK_ORGANIZATION_ID; no benchmark executions were started.',
    );
  }
  return { organizationId: config.organizationId, userId: profile.user?.id };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function evidenceInvariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, field) {
  evidenceInvariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  evidenceInvariant(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${field} has unknown fields or is missing required fields`,
  );
}

function canonicalTimestamp(value, field) {
  evidenceInvariant(typeof value === 'string' && value.endsWith('Z') && !Number.isNaN(Date.parse(value)), `${field} is invalid`);
  evidenceInvariant(new Date(value).toISOString() === value, `${field} must be a canonical ISO-8601 timestamp`);
  return Date.parse(value);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function evidenceReference(value, field) {
  exactKeys(value, ['path', 'sha256'], field);
  evidenceInvariant(typeof value.path === 'string' && value.path.length > 0 && !path.isAbsolute(value.path) && !value.path.split(/[\\/]/u).includes('..'), `${field}.path is invalid`);
  evidenceInvariant(SHA256.test(value.sha256), `${field}.sha256 is invalid`);
  const root = await realpath(repositoryRoot);
  const candidate = path.resolve(root, value.path);
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(`${field}.path does not resolve`);
  }
  const relative = path.relative(root, resolved);
  evidenceInvariant(relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), `${field}.path escapes the repository`);
  let target;
  try {
    target = await stat(resolved);
  } catch {
    throw new Error(`${field}.path does not resolve`);
  }
  evidenceInvariant(target.isFile(), `${field}.path must resolve to a regular file`);
  const bytes = await readFile(resolved);
  evidenceInvariant(createHash('sha256').update(bytes).digest('hex') === value.sha256, `${field}.sha256 does not match file bytes`);
}

function checkedInManifest() {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest.json');
  const bytes = readFileSync(manifestPath);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    value: JSON.parse(bytes),
  };
}

/** Validates a complete, hash-bound evidence artifact and rejects partial or synthetic success. */
export async function validateRepeatChangeEvidence(artifact) {
  exactKeys(artifact, ['schemaVersion', 'kind', 'protocol', 'verdict', 'manifestSha256', 'executions'], 'repeat-change evidence');
  evidenceInvariant(artifact?.schemaVersion === 1, 'repeat-change evidence schemaVersion must be 1');
  evidenceInvariant(artifact?.kind === 'repeat-change-results', 'repeat-change evidence kind is invalid');
  evidenceInvariant(artifact?.protocol === 'PRD-40.2-40.3', 'repeat-change evidence protocol is invalid');
  evidenceInvariant(artifact?.verdict === 'passed', 'repeat-change evidence verdict must be passed');
  evidenceInvariant(SHA256.test(artifact?.manifestSha256 ?? ''), 'repeat-change evidence manifestSha256 is invalid');
  evidenceInvariant(Array.isArray(artifact?.executions) && artifact.executions.length === 50, 'repeat-change evidence must contain exactly 50 executions');

  const manifest = checkedInManifest();
  evidenceInvariant(artifact.manifestSha256 === manifest.sha256, 'repeat-change evidence manifestSha256 does not match the checked-in manifest');
  const expectedChanges = new Map(
    manifest.value.apps.flatMap((app) => app.featureChanges.map((featureChange, changeIndex) => [
      `${app.id}:${String(changeIndex)}`,
      featureChange,
    ])),
  );
  const mappings = new Set();
  const runIds = new Set();
  const rollbackApps = new Set();
  for (const [index, execution] of artifact.executions.entries()) {
    const prefix = `executions[${index}]`;
    exactKeys(execution, ['id', 'appId', 'changeIndex', 'featureChange', 'input', 'output', 'timing', 'measurements', 'cost', 'verifier', 'repair', 'executionSha256'], prefix);
    evidenceInvariant(typeof execution.id === 'string' && execution.id.length > 0, `${prefix}.id is required`);
    evidenceInvariant(typeof execution.appId === 'string' && Number.isInteger(execution.changeIndex), `${prefix}.manifest mapping is invalid`);
    const mapping = `${execution.appId}:${String(execution.changeIndex)}`;
    evidenceInvariant(!mappings.has(mapping), `${prefix}.manifest mapping must be unique`);
    mappings.add(mapping);
    const expectedFeatureChange = expectedChanges.get(mapping);
    evidenceInvariant(expectedFeatureChange !== undefined && execution.featureChange === expectedFeatureChange, `${prefix}.manifest mapping does not match the fixed benchmark`);
    evidenceInvariant(execution.id === mapping, `${prefix}.id must equal its manifest mapping`);
    exactKeys(execution.input, ['prompt', 'sha256'], `${prefix}.input`);
    evidenceInvariant(typeof execution.input?.prompt === 'string' && execution.input.prompt.length > 0, `${prefix}.input.prompt is required`);
    evidenceInvariant(SHA256.test(execution.input?.sha256 ?? ''), `${prefix}.input.sha256 is invalid`);
    evidenceInvariant(
      execution.input.sha256 === sha256({ prompt: execution.input.prompt }),
      `${prefix}.input.sha256 does not match the immutable input`,
    );
    evidenceInvariant(execution.input.prompt === expectedFeatureChange, `${prefix}.input.prompt must equal its manifest feature change`);
    exactKeys(execution.output, ['runId', 'status', 'payload', 'sha256'], `${prefix}.output`);
    evidenceInvariant(typeof execution.output?.runId === 'string' && execution.output.runId.length > 0, `${prefix}.output.runId is required`);
    evidenceInvariant(!runIds.has(execution.output.runId), `${prefix}.output.runId must be unique`);
    runIds.add(execution.output.runId);
    evidenceInvariant(execution.output?.status === 'completed', `${prefix}.output.status must be completed`);
    evidenceInvariant(execution.output?.payload !== undefined, `${prefix}.output.payload is required`);
    evidenceInvariant(SHA256.test(execution.output?.sha256 ?? ''), `${prefix}.output.sha256 is invalid`);
    evidenceInvariant(execution.output.sha256 === sha256(execution.output.payload), `${prefix}.output.sha256 does not match the exact output`);
    exactKeys(execution.timing, ['startedAt', 'completedAt', 'elapsedMs'], `${prefix}.timing`);
    const startedAt = canonicalTimestamp(execution.timing.startedAt, `${prefix}.timing.startedAt`);
    const completedAt = canonicalTimestamp(execution.timing.completedAt, `${prefix}.timing.completedAt`);
    evidenceInvariant(Number.isFinite(execution.timing.elapsedMs) && execution.timing.elapsedMs >= 0 && completedAt - startedAt === execution.timing.elapsedMs, `${prefix}.timing is inconsistent`);
    exactKeys(execution.measurements, ['humanInterventionCount', 'agentIterations', 'escapedRegressionCount', 'timeToVerifiedReleaseMs', 'codeQuality', 'rollback'], `${prefix}.measurements`);
    evidenceInvariant(Number.isInteger(execution.measurements.humanInterventionCount) && execution.measurements.humanInterventionCount >= 0, `${prefix}.measurements.humanInterventionCount is invalid`);
    evidenceInvariant(Number.isInteger(execution.measurements.agentIterations) && execution.measurements.agentIterations > 0, `${prefix}.measurements.agentIterations is invalid`);
    evidenceInvariant(Number.isInteger(execution.measurements.escapedRegressionCount) && execution.measurements.escapedRegressionCount >= 0, `${prefix}.measurements.escapedRegressionCount is invalid`);
    evidenceInvariant(Number.isFinite(execution.measurements.timeToVerifiedReleaseMs) && execution.measurements.timeToVerifiedReleaseMs >= execution.timing.elapsedMs, `${prefix}.measurements.timeToVerifiedReleaseMs is invalid`);
    exactKeys(execution.measurements.codeQuality, ['status', 'result'], `${prefix}.measurements.codeQuality`);
    evidenceInvariant(execution.measurements.codeQuality.status === 'passed', `${prefix}.measurements.codeQuality.status must be passed`);
    await evidenceReference(execution.measurements.codeQuality.result, `${prefix}.measurements.codeQuality.result`);
    exactKeys(execution.measurements.rollback, ['status', 'result'], `${prefix}.measurements.rollback`);
    evidenceInvariant(['not_applicable', 'passed'].includes(execution.measurements.rollback.status), `${prefix}.measurements.rollback.status is invalid`);
    await evidenceReference(execution.measurements.rollback.result, `${prefix}.measurements.rollback.result`);
    if (execution.measurements.rollback.status === 'passed') rollbackApps.add(execution.appId);
    exactKeys(execution.cost, ['credits', 'source'], `${prefix}.cost`);
    evidenceInvariant(typeof execution.cost.credits === 'string' && /^\d+(?:\.\d{1,4})?$/u.test(execution.cost.credits), `${prefix}.cost.credits is invalid`);
    await evidenceReference(execution.cost.source, `${prefix}.cost.source`);
    exactKeys(execution.verifier, ['status', 'result'], `${prefix}.verifier`);
    evidenceInvariant(execution.verifier.status === 'passed', `${prefix}.verifier.status must be passed`);
    await evidenceReference(execution.verifier.result, `${prefix}.verifier.result`);
    exactKeys(execution.repair, ['status', 'attempts', 'result'], `${prefix}.repair`);
    evidenceInvariant(['not_required', 'repaired'].includes(execution.repair.status), `${prefix}.repair.status is invalid`);
    evidenceInvariant(Number.isInteger(execution.repair.attempts) && execution.repair.attempts >= 0 && ((execution.repair.status === 'not_required' && execution.repair.attempts === 0) || (execution.repair.status === 'repaired' && execution.repair.attempts > 0)), `${prefix}.repair.attempts is invalid`);
    await evidenceReference(execution.repair.result, `${prefix}.repair.result`);
    evidenceInvariant(SHA256.test(execution.executionSha256 ?? ''), `${prefix}.executionSha256 is invalid`);
    const { executionSha256, ...immutableExecution } = execution;
    evidenceInvariant(executionSha256 === sha256(immutableExecution), `${prefix}.executionSha256 does not match immutable execution evidence`);
  }
  evidenceInvariant(mappings.size === expectedChanges.size && [...expectedChanges.keys()].every((key) => mappings.has(key)), 'repeat-change evidence must cover each fixed manifest mapping exactly once');
  evidenceInvariant(rollbackApps.size === manifest.value.apps.length && manifest.value.apps.every((app) => rollbackApps.has(app.id)), 'repeat-change evidence must contain one passed rollback for every benchmark app');
  return artifact;
}

async function main() {
  const config = loadBenchmarkRunnerConfig();
  const session = await preflightPublicApi(config);
  process.stdout.write(`public API preflight passed for ${session.organizationId}; no benchmark executions were started by preflight.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
