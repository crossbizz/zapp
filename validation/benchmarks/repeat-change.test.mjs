import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const repositoryRoot = path.resolve(directory, '..', '..');
const evidenceDirectory = mkdtempSync(path.join(directory, '.repeat-change-evidence-'));

test.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));

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
  const bytes = readFileSync(path.join(repositoryRoot, pathname));
  return { path: pathname, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function commonEvidence(app, changeIndex) {
  return {
    executionId: `${app.id}:${String(changeIndex)}`,
    appId: app.id,
    runId: `run_${app.id}_${String(changeIndex)}`,
  };
}

function evidenceSource(filename, kind, records) {
  const pathname = path.join(evidenceDirectory, filename);
  writeFileSync(pathname, `${JSON.stringify({ schemaVersion: 1, kind, records })}\n`);
  return source(path.relative(repositoryRoot, pathname));
}

function allEvidenceRecords(record) {
  return manifest.apps.flatMap((app) => app.featureChanges.map((_, changeIndex) => (
    record(app, changeIndex)
  )));
}

const evidenceReferences = {
  codeQuality: evidenceSource(
    'code-quality.json',
    'repeat-change-code-quality-results',
    allEvidenceRecords((app, changeIndex) => ({
      ...commonEvidence(app, changeIndex),
      status: 'passed',
      checks: [
        { name: 'lint', status: 'passed' },
        { name: 'typecheck', status: 'passed' },
        { name: 'test', status: 'passed' },
      ],
    })),
  ),
  rollback: evidenceSource(
    'rollback.json',
    'repeat-change-rollback-results',
    allEvidenceRecords((app, changeIndex) => ({
      ...commonEvidence(app, changeIndex),
      status: changeIndex === 0 ? 'passed' : 'not_applicable',
      targetReleaseId: changeIndex === 0 ? `release_${app.id}_baseline` : null,
      restoredReleaseId: changeIndex === 0 ? `release_${app.id}_baseline` : null,
      verificationRunId: changeIndex === 0 ? `verify_rollback_${app.id}` : null,
    })),
  ),
  cost: evidenceSource(
    'cost.json',
    'repeat-change-cost-results',
    allEvidenceRecords((app, changeIndex) => ({
      ...commonEvidence(app, changeIndex),
      credits: '1.0000',
      usageEventIds: [`usage_${app.id}_${String(changeIndex)}`],
    })),
  ),
  verifier: evidenceSource(
    'verifier.json',
    'repeat-change-verifier-results',
    allEvidenceRecords((app, changeIndex) => ({
      ...commonEvidence(app, changeIndex),
      status: 'passed',
      decisionId: `decision_${app.id}_${String(changeIndex)}`,
      evidenceManifestSha256: manifestSha256,
    })),
  ),
  repair: evidenceSource(
    'repair.json',
    'repeat-change-repair-results',
    allEvidenceRecords((app, changeIndex) => ({
      ...commonEvidence(app, changeIndex),
      status: 'not_required',
      attempts: 0,
      taskId: null,
    })),
  ),
};

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
      codeQuality: { status: 'passed', result: { ...evidenceReferences.codeQuality } },
      rollback: {
        status: changeIndex === 0 ? 'passed' : 'not_applicable',
        result: { ...evidenceReferences.rollback },
      },
    },
    cost: { credits: '1.0000', source: { ...evidenceReferences.cost } },
    verifier: { status: 'passed', result: { ...evidenceReferences.verifier } },
    repair: { status: 'not_required', attempts: 0, result: { ...evidenceReferences.repair } },
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
  const changed = { ...target.executions[index] };
  delete changed.executionSha256;
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

test('repeat-change evidence rejects unrelated, wrong-kind, and unbound semantic evidence', async () => {
  const unrelated = artifact();
  unrelated.executions[0].measurements.rollback.result = source('validation/benchmarks/manifest.json');
  rehash(unrelated, 0);
  await rejectsEvidence(
    () => validateRepeatChangeEvidence(unrelated),
    /measurements.rollback.result.kind is invalid/u,
  );

  const wrongKind = artifact();
  wrongKind.executions[0].verifier.result = { ...evidenceReferences.codeQuality };
  rehash(wrongKind, 0);
  await rejectsEvidence(
    () => validateRepeatChangeEvidence(wrongKind),
    /verifier.result.kind is invalid/u,
  );

  const wrongBinding = artifact();
  const execution = wrongBinding.executions[0];
  execution.measurements.rollback.result = evidenceSource(
    'wrong-binding.json',
    'repeat-change-rollback-results',
    [{
      executionId: execution.id,
      appId: manifest.apps[1].id,
      runId: execution.output.runId,
      status: 'passed',
      targetReleaseId: 'release_wrong_app',
      restoredReleaseId: 'release_wrong_app',
      verificationRunId: 'verify_wrong_app',
    }],
  );
  rehash(wrongBinding, 0);
  await rejectsEvidence(
    () => validateRepeatChangeEvidence(wrongBinding),
    /measurements.rollback.result record does not match appId/u,
  );

  const wrongOutcome = artifact();
  const outcomeExecution = wrongOutcome.executions[0];
  outcomeExecution.measurements.rollback.result = evidenceSource(
    'wrong-outcome.json',
    'repeat-change-rollback-results',
    [{
      ...commonEvidence(manifest.apps[0], 0),
      status: 'not_applicable',
      targetReleaseId: null,
      restoredReleaseId: null,
      verificationRunId: null,
    }],
  );
  rehash(wrongOutcome, 0);
  await rejectsEvidence(
    () => validateRepeatChangeEvidence(wrongOutcome),
    /measurements.rollback.result record does not match status/u,
  );
});

test('repeat-change evidence rejects passed artifacts without a verified rollback for every app', async () => {
  const withoutRollbacks = artifact();
  const noRollbackEvidence = evidenceSource(
    'no-rollbacks.json',
    'repeat-change-rollback-results',
    allEvidenceRecords((app, changeIndex) => ({
      ...commonEvidence(app, changeIndex),
      status: 'not_applicable',
      targetReleaseId: null,
      restoredReleaseId: null,
      verificationRunId: null,
    })),
  );
  for (const item of withoutRollbacks.executions) {
    item.measurements.rollback.status = 'not_applicable';
    item.measurements.rollback.result = { ...noRollbackEvidence };
    rehash(withoutRollbacks, withoutRollbacks.executions.indexOf(item));
  }

  await rejectsEvidence(
    () => validateRepeatChangeEvidence(withoutRollbacks),
    /must contain one passed rollback for every benchmark app/u,
  );
});
