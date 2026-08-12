import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { evaluateGoNoGo, loadGoNoGoPolicy, validateGoNoGoPolicy } from './evaluate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

function passingInput(policy) {
  return {
    schemaVersion: 1,
    sourceArtifacts: [
      {
        path: 'validation/benchmarks/manifest.json',
        kind: 'repeat-change-results',
        sha256: 'a'.repeat(64),
      },
      {
        path: 'validation/exit-criteria/evidence/2026-08-12-local.json',
        kind: 'agency-validation-results',
        sha256: 'b'.repeat(64),
      },
    ],
    metrics: {
      templatePreviewRate: { numerator: 91, denominator: 100 },
      importedPreviewRate: { numerator: 71, denominator: 100 },
      scopedBuildWithinOneRepairRate: { numerator: 76, denominator: 100 },
      criticalBrowserFlowPassRate: { numerator: 50, denominator: 50 },
      exactRollbackRate: { numerator: 10, denominator: 10 },
      escapedCriticalRegressionRate: { numerator: 4, denominator: 100 },
      modelModalCostShare: { numerator: 24, denominator: 100 },
      agencyWillingToPay: { numerator: 3, denominator: 5 },
    },
    invalidationSignals: policy.invalidationSignals.map(({ id }) => ({
      id,
      observed: false,
      evidence: [],
    })),
  };
}

test('V-4 policy encodes all eight PRD thresholds and seven invalidation signals', async () => {
  const result = validateGoNoGoPolicy(await loadGoNoGoPolicy(root));
  assert.deepEqual(result, { thresholds: 8, invalidationSignals: 7 });
});

test('V-4 returns go only when every strict threshold passes', async () => {
  const policy = await loadGoNoGoPolicy(root);
  assert.equal(evaluateGoNoGo(passingInput(policy), policy).verdict, 'go');

  for (const [metric, boundary] of [
    ['templatePreviewRate', { numerator: 90, denominator: 100 }],
    ['importedPreviewRate', { numerator: 70, denominator: 100 }],
    ['scopedBuildWithinOneRepairRate', { numerator: 75, denominator: 100 }],
    ['criticalBrowserFlowPassRate', { numerator: 49, denominator: 50 }],
    ['exactRollbackRate', { numerator: 9, denominator: 10 }],
    ['escapedCriticalRegressionRate', { numerator: 5, denominator: 100 }],
    ['modelModalCostShare', { numerator: 25, denominator: 100 }],
    ['agencyWillingToPay', { numerator: 2, denominator: 5 }],
  ]) {
    const input = passingInput(policy);
    input.metrics[metric] = boundary;
    assert.equal(evaluateGoNoGo(input, policy).verdict, 'no-go', metric);
  }
});

test('V-4 fails closed for missing metrics or a non-five-agency sample', async () => {
  const policy = await loadGoNoGoPolicy(root);
  const missingInput = passingInput(policy);
  missingInput.metrics = {};
  const missing = evaluateGoNoGo(missingInput, policy);
  assert.equal(missing.verdict, 'blocked');
  assert.equal(missing.missingMetrics.length, 8);

  const invalidSample = passingInput(policy);
  invalidSample.metrics.agencyWillingToPay.denominator = 4;
  assert.throws(() => evaluateGoNoGo(invalidSample, policy), /first five agencies/u);
});

test('V-4 blocks missing evidence and signal review, and no-goes an observed signal', async () => {
  const policy = await loadGoNoGoPolicy(root);
  const noEvidence = passingInput(policy);
  noEvidence.sourceArtifacts = [];
  const noEvidenceResult = evaluateGoNoGo(noEvidence, policy);
  assert.equal(noEvidenceResult.verdict, 'blocked');
  assert.deepEqual(noEvidenceResult.missingEvidenceKinds, [
    'repeat-change-results',
    'agency-validation-results',
  ]);

  const incompleteReview = passingInput(policy);
  incompleteReview.invalidationSignals[0].observed = null;
  assert.equal(evaluateGoNoGo(incompleteReview, policy).verdict, 'blocked');

  const invalidated = passingInput(policy);
  invalidated.invalidationSignals[0] = {
    id: 'I1',
    observed: true,
    evidence: ['validation/exit-criteria/evidence/2026-08-12-local.json'],
  };
  assert.equal(evaluateGoNoGo(invalidated, policy).verdict, 'no-go');
});

test('V-4 rejects impossible bounded rates', async () => {
  const policy = await loadGoNoGoPolicy(root);
  const input = passingInput(policy);
  input.metrics.templatePreviewRate = { numerator: 101, denominator: 100 };
  assert.throws(() => evaluateGoNoGo(input, policy), /cannot exceed its denominator/u);
});
