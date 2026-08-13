import { newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import {
  BROWSER_RUN_LEASE_MS,
  BrowserRunInputSchema,
  browserRunIdempotencyKey,
  browserRunLeaseExpired,
  classifyTestArtifacts,
  createR2EvidenceObjectStore,
  type BrowserRunInput,
} from '../src/runner/playwright.js';

function input(): BrowserRunInput {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const testRunId = newId('trun');
  return {
    idempotencyKey: browserRunIdempotencyKey({ organizationId, projectId, testRunId }),
    organizationId,
    projectId,
    branchId: newId('br'),
    branchName: 'main',
    workspaceId: newId('ws'),
    workspaceCreatedAt: '2026-08-10T18:00:00.000Z',
    runId: newId('run'),
    taskId: newId('task'),
    testRunId,
    commitSha: 'b'.repeat(40),
    suitePath: 'e2e/zapp',
    previewProxyUrl: 'https://preview.example.test',
    secretScan: {
      status: 'passed',
      evidenceArtifactId: newId('art'),
    },
  };
}

describe('VF-7 browser-run boundaries', () => {
  it('classifies every browser artifact explicitly for the 30-day test TTL', () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const artifactId = newId('art');
    const createdAt = new Date('2026-08-12T00:00:00.000Z');
    expect(
      classifyTestArtifacts(
        [
          {
            id: artifactId,
            organizationId,
            projectId,
            runId: newId('run'),
            taskId: null,
            type: 'playwright_json_report',
            storageRef: `org/${organizationId}/project/${projectId}/test/report.json`,
            contentHash: 'a'.repeat(64),
            metadataJson: {},
          },
        ],
        createdAt,
      ),
    ).toEqual([
      {
        artifactId,
        organizationId,
        projectId,
        retentionClass: 'test',
        expiresAt: new Date('2026-09-11T00:00:00.000Z'),
      },
    ]);
  });

  it('binds the idempotency key to the tenant, project, and test run', () => {
    const run = input();
    expect(BrowserRunInputSchema.parse(run)).toEqual(run);
    expect(
      BrowserRunInputSchema.safeParse({
        ...run,
        idempotencyKey: browserRunIdempotencyKey({
          organizationId: run.organizationId,
          projectId: run.projectId,
          testRunId: newId('trun'),
        }),
      }).success,
    ).toBe(false);
    expect(
      BrowserRunInputSchema.safeParse({
        ...run,
        previewProxyUrl: 'file:///workspace/index.html',
      }).success,
    ).toBe(false);
    const withoutSecretScan: Partial<BrowserRunInput> = { ...run };
    delete withoutSecretScan.secretScan;
    expect(BrowserRunInputSchema.safeParse(withoutSecretScan).success).toBe(false);
  });

  it('writes R2 evidence with its hash and content type metadata', async () => {
    const commands: unknown[] = [];
    const store = createR2EvidenceObjectStore({
      bucket: 'zapp-artifacts',
      client: {
        send(command) {
          commands.push(command);
          return Promise.resolve({});
        },
      },
    });
    await store.put({
      storageRef: 'org/example/screenshot.png',
      body: Buffer.from('screenshot'),
      contentHash: 'c'.repeat(64),
      contentType: 'image/png',
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      input: {
        Bucket: 'zapp-artifacts',
        Key: 'org/example/screenshot.png',
        ContentType: 'image/png',
        Metadata: { sha256: 'c'.repeat(64) },
      },
    });
  });

  it('reclaims only browser runs whose execution lease has expired', () => {
    const startedAt = new Date('2026-08-10T18:00:00.000Z');
    expect(
      browserRunLeaseExpired(
        startedAt,
        new Date(startedAt.getTime() + BROWSER_RUN_LEASE_MS - 1),
      ),
    ).toBe(false);
    expect(
      browserRunLeaseExpired(
        startedAt,
        new Date(startedAt.getTime() + BROWSER_RUN_LEASE_MS),
      ),
    ).toBe(true);
  });
});
