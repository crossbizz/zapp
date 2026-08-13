import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  loadExitCriteriaManifest,
  validateExitCriteriaManifest,
  validateResultArtifact,
} from './validate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const execFile = promisify(execFileCallback);

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
    { verified: 17, candidate: 4, failed: 0, blocked: 1 },
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

test('V-3 binds v2 evidence to exact manifest commands and captured output bytes', async (t) => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'zapp-exit-evidence-'));
  t.after(async () => rm(repositoryRoot, { recursive: true, force: true }));
  await mkdir(path.join(repositoryRoot, 'evidence', 'output'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'source.ts'), 'export const evidence = true;\n');
  await execFile('git', ['-C', repositoryRoot, 'init', '--quiet']);
  await execFile('git', ['-C', repositoryRoot, 'add', 'source.ts']);
  await execFile('git', [
    '-C',
    repositoryRoot,
    '-c',
    'user.name=Evidence Test',
    '-c',
    'user.email=evidence@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const baseline = (
    await execFile('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const capturedAt = '2026-08-13T15:00:00.000Z';
  const command = 'pnpm test -- exact.test.ts';
  const output = Buffer.from(
    `zapp-exit-evidence-v2\nbaseline: ${baseline}\ncapturedAt: ${capturedAt}\ncommand: ${command}\n---\n1 passed\n`,
  );
  const digest = createHash('sha256').update(output).digest('hex');
  const outputArtifact = `evidence/output/${digest}.log`;
  await writeFile(path.join(repositoryRoot, outputArtifact), output);
  const artifactPath = 'evidence/result.json';
  const artifact = {
    schemaVersion: 2,
    baseline,
    capturedAt,
    results: [
      {
        criterionId: 'E8',
        outcome: 'passed',
        commands: [
          {
            command,
            exitCode: 0,
            summary: '1/1 passed',
            outputArtifact,
            outputSha256: `sha256:${digest}`,
          },
        ],
      },
    ],
  };
  await writeFile(path.join(repositoryRoot, artifactPath), JSON.stringify(artifact));
  const criterion = {
    id: 'E8',
    state: 'verified',
    verifyCommands: [command],
    requiredEvidenceSchemaVersion: 2,
    sourceEvidence: ['source.ts'],
  };

  await validateResultArtifact(repositoryRoot, artifactPath, criterion, 'evidence');

  artifact.results[0].commands[0].command = 'pnpm test -- unrelated.test.ts';
  await writeFile(path.join(repositoryRoot, artifactPath), JSON.stringify(artifact));
  await assert.rejects(
    validateResultArtifact(repositoryRoot, artifactPath, criterion, 'evidence'),
    /commands must exactly match verifyCommands/u,
  );
  artifact.results[0].commands[0].command = command;
  artifact.results[0].commands[0].outputSha256 = `sha256:${'0'.repeat(64)}`;
  await writeFile(path.join(repositoryRoot, artifactPath), JSON.stringify(artifact));
  await assert.rejects(
    validateResultArtifact(repositoryRoot, artifactPath, criterion, 'evidence'),
    /outputSha256 must match captured bytes/u,
  );

  artifact.baseline = '0'.repeat(40);
  await writeFile(path.join(repositoryRoot, artifactPath), JSON.stringify(artifact));
  await assert.rejects(
    validateResultArtifact(repositoryRoot, artifactPath, criterion, 'evidence'),
    /baseline must identify a repository commit/u,
  );
  artifact.baseline = baseline;
  criterion.sourceEvidence = ['not-at-baseline.ts'];
  await writeFile(path.join(repositoryRoot, artifactPath), JSON.stringify(artifact));
  await assert.rejects(
    validateResultArtifact(repositoryRoot, artifactPath, criterion, 'evidence'),
    /sourceEvidence must be a regular file at baseline/u,
  );
});
