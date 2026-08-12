import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import type { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  SignedVerificationArtifactSchema,
  VerificationTestRunSchema,
  type VerificationReadModel,
} from '@zapp/verification-engine';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { createR2EvidenceReadSigner } from '../src/read-model.js';

const NOW = new Date('2026-08-12T18:00:00.000Z');

function ids() {
  return {
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    taskId: newId('task'),
    testRunId: newId('trun'),
    testCaseId: newId('tcase'),
    artifactId: newId('art'),
  };
}

describe('VF-17 public evidence read boundary', () => {
  it('authorizes only the control plane and preserves run, task, case, and criterion provenance', async () => {
    const value = ids();
    const readModel: VerificationReadModel = {
      listForRun: vi.fn(() => Promise.resolve([VerificationTestRunSchema.parse({
        id: value.testRunId,
        organizationId: value.organizationId,
        runId: value.runId,
        taskId: value.taskId,
        commitSha: 'a'.repeat(40),
        type: 'browser',
        status: 'failed',
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        summary: { total: 1, failed: 1 },
        cases: [{
          id: value.testCaseId,
          testRunId: value.testRunId,
          name: '[AC-1] renders an accessible heading',
          status: 'failed',
          durationMs: 42,
          criterionIds: ['AC-1'],
          evidenceArtifactIds: [value.artifactId],
          error: { message: 'heading missing' },
        }],
        casesTruncated: false,
      })])),
      signArtifact: vi.fn(() => Promise.resolve(SignedVerificationArtifactSchema.parse({
        artifact: {
          id: value.artifactId,
          organizationId: value.organizationId,
          projectId: value.projectId,
          runId: value.runId,
          taskId: value.taskId,
          testRunId: value.testRunId,
          testCaseId: value.testCaseId,
          criterionIds: ['AC-1'],
          kind: 'screenshot',
          description: 'Failure screenshot for accessible heading',
          contentType: 'image/png',
          byteSize: 4,
          contentHash: 'b'.repeat(64),
          createdAt: NOW.toISOString(),
        },
        download: {
          url: 'https://evidence.example.test/signed',
          expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
        },
      }))),
    };
    const signer = createServiceTokenSigner({ secret: 'v'.repeat(64) });
    const app = buildApp({
      signer,
      readModel,
      browserRuns: { run: vi.fn(() => Promise.reject(new Error('not used'))) },
      logger: false,
      now: () => NOW,
    });
    const controlToken = await signer.signServiceToken({
      service: 'control-api', aud: 'verification-service', now: NOW,
    });
    const workerToken = await signer.signServiceToken({
      service: 'orchestrator-worker', aud: 'verification-service', now: NOW,
    });

    try {
      const list = await app.inject({
        method: 'GET',
        url: `/internal/verification/organizations/${value.organizationId}/runs/${value.runId}/tests`,
        headers: { 'x-zapp-service-token': controlToken.token },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        runs: [{ id: value.testRunId, taskId: value.taskId, cases: [{ criterionIds: ['AC-1'] }] }],
      });

      const artifact = await app.inject({
        method: 'GET',
        url: `/internal/verification/organizations/${value.organizationId}/runs/${value.runId}/artifacts/${value.artifactId}?taskId=${value.taskId}`,
        headers: { 'x-zapp-service-token': controlToken.token },
      });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.json()).toMatchObject({
        artifact: {
          id: value.artifactId,
          taskId: value.taskId,
          testRunId: value.testRunId,
          testCaseId: value.testCaseId,
          criterionIds: ['AC-1'],
          description: 'Failure screenshot for accessible heading',
        },
      });
      expect(JSON.stringify(artifact.json())).not.toContain('storageRef');

      const forbidden = await app.inject({
        method: 'GET',
        url: `/internal/verification/organizations/${value.organizationId}/runs/${value.runId}/tests`,
        headers: { 'x-zapp-service-token': workerToken.token },
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('signs only the requested R2 key for five minutes', async () => {
    const presign = vi.fn((_client: S3Client, command: GetObjectCommand, expiresIn: number) => {
      expect(command.input).toEqual({ Bucket: 'evidence', Key: 'org/org_1/run/run_1/a.png' });
      expect(expiresIn).toBe(300);
      return Promise.resolve('https://r2.example.test/signed');
    });
    const signer = createR2EvidenceReadSigner({
      client: {} as never,
      bucket: 'evidence',
      now: () => NOW,
      presign,
    });

    await expect(signer.signRead({
      storageRef: 'org/org_1/run/run_1/a.png',
      expiresInSeconds: 300,
    })).resolves.toEqual({
      url: 'https://r2.example.test/signed',
      expiresAt: '2026-08-12T18:05:00.000Z',
    });
  });
});
