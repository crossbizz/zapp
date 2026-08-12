import { describe, expect, it } from 'vitest';

import {
  MAX_PUBLIC_EVIDENCE_BYTES,
  VerificationArtifactRecordSchema,
  createVerificationReadModel,
} from '../src/read-model.js';

const ids = {
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
  taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
  testRunId: 'trun_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
  testCaseId: 'tcase_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
  artifactId: 'art_01J8ME7YQZJ2V9Q0X3T5B6K7NY',
};

const artifact = {
  id: ids.artifactId,
  organizationId: ids.organizationId,
  projectId: ids.projectId,
  runId: ids.runId,
  taskId: ids.taskId,
  testRunId: ids.testRunId,
  testCaseId: ids.testCaseId,
  criterionIds: ['AC-1'],
  kind: 'screenshot' as const,
  description: 'Checkout confirmation with the order number visible.',
  contentType: 'image/png',
  byteSize: 1_024,
  contentHash: 'a'.repeat(64),
  storageRef: `org/${ids.organizationId}/run/${ids.runId}/evidence.png`,
  createdAt: '2026-08-12T20:00:00.000Z',
};

describe('VF-17 verification read model', () => {
  it('requires complete provenance and accessible descriptions for visual evidence', () => {
    expect(VerificationArtifactRecordSchema.parse(artifact)).toEqual(artifact);
    expect(() => VerificationArtifactRecordSchema.parse({ ...artifact, description: null })).toThrow();
    expect(() => VerificationArtifactRecordSchema.parse({ ...artifact, runId: null })).toThrow();
    expect(() => VerificationArtifactRecordSchema.parse({ ...artifact, byteSize: MAX_PUBLIC_EVIDENCE_BYTES + 1 })).toThrow();
  });

  it('returns bounded test/case metadata and signs only an exact-provenance artifact', async () => {
    const signInputs: unknown[] = [];
    const model = createVerificationReadModel({
      store: {
        listForRun() {
          return Promise.resolve([{
            id: ids.testRunId, organizationId: ids.organizationId, runId: ids.runId,
            taskId: ids.taskId, commitSha: 'b'.repeat(40), type: 'browser', status: 'failed',
            startedAt: '2026-08-12T19:59:00.000Z', completedAt: '2026-08-12T20:00:00.000Z',
            summary: { passed: 0, failed: 1, skipped: 0, durationMs: 1_000 },
            cases: [{
              id: ids.testCaseId, testRunId: ids.testRunId, name: '[AC-1] checkout',
              status: 'failed', durationMs: 1_000, criterionIds: ['AC-1'],
              evidenceArtifactIds: [ids.artifactId], error: { message: 'expected order number' },
            }],
          }]);
        },
        getArtifact() { return Promise.resolve(artifact); },
      },
      signer: {
        signRead(input) {
          signInputs.push(input);
          return Promise.resolve({ url: 'https://r2.example.test/signed', expiresAt: '2026-08-12T20:05:00.000Z' });
        },
      },
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    });

    const runs = await model.listForRun({ organizationId: ids.organizationId, runId: ids.runId });
    const signed = await model.signArtifact({
      organizationId: ids.organizationId, runId: ids.runId, taskId: ids.taskId,
      artifactId: ids.artifactId,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.cases[0]).toMatchObject({ criterionIds: ['AC-1'], evidenceArtifactIds: [ids.artifactId] });
    expect(signed.artifact).not.toHaveProperty('storageRef');
    expect(signed.download).toEqual({ url: 'https://r2.example.test/signed', expiresAt: '2026-08-12T20:05:00.000Z' });
    expect(signInputs).toEqual([{ storageRef: artifact.storageRef, expiresInSeconds: 300 }]);
  });
});
