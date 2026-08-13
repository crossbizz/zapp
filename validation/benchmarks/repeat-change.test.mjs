import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BenchmarkPreflightError,
  loadBenchmarkRunnerConfig,
  validateRepeatChangeEvidence,
} from './repeat-change.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifestBytes = readFileSync(path.join(directory, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function source(pathname) {
  const bytes = readFileSync(path.join(directory, '..', '..', pathname));
  return { path: pathname, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function execution(app, changeIndex) {
  const input = { prompt: app.featureChanges[changeIndex] };
  const output = {
    runId: `run_${app.id}_${String(changeIndex)}`,
    status: 'completed',
    payload: { run: { status: 'completed' } },
    sha256: digest({ run: { status: 'completed' } }),
  };
  const value = {
    id: `${app.id}:${String(changeIndex)}`,
    appId: app.id,
    changeIndex,
    featureChange: app.featureChanges[changeIndex],
    input: { ...input, sha256: digest(input) },
    output,
    timing: { startedAt: '2026-08-12T00:00:00.000Z', completedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000 },
    measurements: {
      humanInterventionCount: 0,
      agentIterations: 1,
      escapedRegressionCount: 0,
      timeToVerifiedReleaseMs: 1000,
      codeQuality: { status: 'passed', result: source('validation/benchmarks/manifest.json') },
      rollback: {
        status: changeIndex === 0 ? 'passed' : 'not_applicable',
        result: source('validation/benchmarks/manifest.json'),
      },
    },
    cost: { credits: '1.0000', source: source('validation/benchmarks/manifest.json') },
    verifier: { status: 'passed', result: source('validation/benchmarks/manifest.json') },
    repair: { status: 'not_required', attempts: 0, result: source('validation/benchmarks/manifest.json') },
  };
  return { ...value, executionSha256: digest(value) };
}

function artifact() {
  return {
    schemaVersion: 1,
    kind: 'repeat-change-results',
    protocol: 'PRD-40.2-40.3',
    verdict: 'passed',
    manifestSha256,
    executions: manifest.apps.flatMap((app) => app.featureChanges.map((_, index) => execution(app, index))),
  };
}

function rehash(target, index) {
  const { executionSha256: _oldHash, ...changed } = target.executions[index];
  target.executions[index].executionSha256 = digest(changed);
}

async function rejectsEvidence(operation, pattern) {
  let result;
  try {
    result = operation();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
    return;
  }
  await assert.rejects(Promise.resolve(result), pattern);
}

test('benchmark preflight refuses to start without a public bearer credential', () => {
  assert.throws(
    () => loadBenchmarkRunnerConfig({ ZAPP_BENCHMARK_API_BASE_URL: 'https://api.example.test' }),
    (error) => error instanceof BenchmarkPreflightError && error.code === 'missing_bearer_token',
  );
});

test('repeat-change evidence accepts every fixed manifest app and feature change exactly once', async () => {
  assert.equal((await validateRepeatChangeEvidence(artifact())).executions.length, 50);
});

test('repeat-change evidence rejects forged manifest digests and duplicate manifest mappings', async () => {
  const forged = artifact();
  forged.manifestSha256 = 'a'.repeat(64);
  await rejectsEvidence(() => validateRepeatChangeEvidence(forged), /does not match the checked-in manifest/u);

  const duplicate = artifact();
  duplicate.executions[1].appId = duplicate.executions[0].appId;
  duplicate.executions[1].changeIndex = duplicate.executions[0].changeIndex;
  duplicate.executions[1].featureChange = duplicate.executions[0].featureChange;
  rehash(duplicate, 1);
  await rejectsEvidence(() => validateRepeatChangeEvidence(duplicate), /mapping must be unique/u);
});

test('repeat-change evidence rejects status-only measurements and inconsistent or extended evidence', async () => {
  const statusOnly = artifact();
  statusOnly.executions[0].cost = { credits: '0' };
  rehash(statusOnly, 0);
  await rejectsEvidence(() => validateRepeatChangeEvidence(statusOnly), /cost has unknown fields|cost.source is invalid/u);

  const timing = artifact();
  timing.executions[0].timing = { startedAt: '2026-08-12T01:00:00.000Z', completedAt: '2026-08-12T00:00:00.000Z', elapsedMs: 7 };
  rehash(timing, 0);
  await rejectsEvidence(() => validateRepeatChangeEvidence(timing), /timing is inconsistent/u);

  const extended = artifact();
  extended.executions[0].output.extra = 'forged';
  rehash(extended, 0);
  await rejectsEvidence(() => validateRepeatChangeEvidence(extended), /output has unknown fields/u);
});

test('repeat-change evidence rejects a prompt that is not its manifest feature change', async () => {
  const unrelatedInput = artifact();
  unrelatedInput.executions[0].input.prompt = 'Add a dark mode toggle.';
  unrelatedInput.executions[0].input.sha256 = digest({ prompt: unrelatedInput.executions[0].input.prompt });
  rehash(unrelatedInput, 0);

  await rejectsEvidence(
    () => validateRepeatChangeEvidence(unrelatedInput),
    /input.prompt must equal its manifest feature change/u,
  );
});

test('repeat-change evidence rejects missing, mismatched, or non-regular evidence references', async () => {
  const missing = artifact();
  missing.executions[0].verifier.result = { path: 'definitely-does-not-exist/verifier.json', sha256: 'a'.repeat(64) };
  rehash(missing, 0);
  await rejectsEvidence(() => validateRepeatChangeEvidence(missing), /verifier.result.path does not resolve/u);

  const digestMismatch = artifact();
  digestMismatch.executions[0].verifier.result.sha256 = 'a'.repeat(64);
  rehash(digestMismatch, 0);
  await rejectsEvidence(() => validateRepeatChangeEvidence(digestMismatch), /verifier.result.sha256 does not match file bytes/u);

  const directoryReference = artifact();
  directoryReference.executions[0].verifier.result = { path: 'validation/benchmarks', sha256: manifestSha256 };
  rehash(directoryReference, 0);
  await rejectsEvidence(() => validateRepeatChangeEvidence(directoryReference), /verifier.result.path must resolve to a regular file/u);
});

test('repeat-change evidence rejects passed artifacts without a verified rollback for every app', async () => {
  const withoutRollbacks = artifact();
  for (const item of withoutRollbacks.executions) {
    item.measurements.rollback.status = 'not_applicable';
    rehash(withoutRollbacks, withoutRollbacks.executions.indexOf(item));
  }

  await rejectsEvidence(
    () => validateRepeatChangeEvidence(withoutRollbacks),
    /must contain one passed rollback for every benchmark app/u,
  );
});
