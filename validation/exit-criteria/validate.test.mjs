import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadExitCriteriaManifest, validateExitCriteriaManifest } from './validate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

test('V-3 matrix covers E1 through E22 exactly once with repository evidence', async () => {
  const result = await validateExitCriteriaManifest(await loadExitCriteriaManifest(root), root);

  assert.equal(result.criteria, 22);
  assert.deepEqual(
    result.ids,
    Array.from({ length: 22 }, (_, index) => `E${index + 1}`),
  );
  assert.deepEqual(
    {
      verified: result.verified,
      candidate: result.candidate,
      failed: result.failed,
      blocked: result.blocked,
    },
    { verified: 18, candidate: 3, failed: 0, blocked: 1 },
  );
});

test('V-3 rejects a verified claim without a captured artifact', async () => {
  const manifest = structuredClone(await loadExitCriteriaManifest(root));
  manifest.criteria[2].state = 'verified';
  manifest.criteria[2].evidenceArtifacts = [];

  await assert.rejects(
    validateExitCriteriaManifest(manifest, root),
    /verified criteria require at least one evidence artifact/u,
  );
});

test('V-3 rejects an unrelated file presented as criterion evidence', async () => {
  const manifest = structuredClone(await loadExitCriteriaManifest(root));
  manifest.criteria[2].state = 'verified';
  manifest.criteria[2].evidenceArtifacts = ['package.json'];

  await assert.rejects(
    validateExitCriteriaManifest(manifest, root),
    /evidence artifact schemaVersion/u,
  );
});

test('V-3 rejects duplicate criteria and evidence paths outside the repository', async () => {
  const manifest = structuredClone(await loadExitCriteriaManifest(root));
  manifest.criteria[1].id = 'E1';
  manifest.criteria[0].sourceEvidence = ['../../outside'];

  await assert.rejects(
    validateExitCriteriaManifest(manifest, root),
    /criterion id must be unique|repository-relative/u,
  );
});

test('V-3 binds criterion prose and readiness state to the PRD and task tracker', async () => {
  const proseDrift = structuredClone(await loadExitCriteriaManifest(root));
  proseDrift.criteria[0].criterion = 'Almost the same criterion';
  await assert.rejects(validateExitCriteriaManifest(proseDrift, root), /must match PRD §39/u);

  const falseCandidate = structuredClone(await loadExitCriteriaManifest(root));
  falseCandidate.criteria[21].state = 'candidate';
  delete falseCandidate.criteria[21].blocker;
  await assert.rejects(
    validateExitCriteriaManifest(falseCandidate, root),
    /candidate criteria require all tasks checked/u,
  );
});
