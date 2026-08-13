import { newId } from '@zapp/contracts';
import type { AgentRun, Workspace } from '@zapp/db';
import { SignedVerificationArtifactSchema } from '@zapp/verification-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TestRunsResponseSchema,
  type BuilderArtifactPort,
} from '../src/routes/builder-artifacts.js';
import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { EMPTY_WORKSPACE_USAGE, InMemoryTenantData } from './support/tenant-db.js';
import { createBuilderArtifactClient } from '../src/builder-artifacts/client.js';

const OWNER: AuthIdentity = {
  externalId: 'builder-artifact-owner',
  email: 'owner@builder-artifacts.test',
  displayName: 'Builder Artifact Owner',
};
const NOW = new Date('2026-08-12T19:00:00.000Z');
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.app.close()));
});

describe('CP-24 public builder artifact surfaces', () => {
  it('bridges tenant-owned workspace, comparison, test, and evidence reads without credentials', async () => {
    const data = new InMemoryTenantData();
    const listFiles = vi.fn(() => Promise.resolve({
      entries: [{ path: 'src/App.tsx', type: 'file' as const }],
      truncated: false,
    }));
    const editFile = vi.fn((input: Parameters<BuilderArtifactPort['editFile']>[0]) => {
      expect(input.path).toBe('src/App.tsx');
      return Promise.resolve({
        path: 'src/App.tsx',
        commitRef: 'a'.repeat(40),
        compareToken: 'b'.repeat(64),
      });
    });
    const artifacts: BuilderArtifactPort = {
      listFiles,
      readFile: vi.fn(() => Promise.resolve({
        path: 'src/App.tsx',
        dataBase64: Buffer.from('export default 1;').toString('base64'),
        byteSize: 17,
        compareToken: 'c'.repeat(64),
      })),
      editFile,
      compareCommits: vi.fn(() => Promise.resolve({
        beforeSha: '1'.repeat(40),
        afterSha: '2'.repeat(40),
        changedFiles: 1,
        files: [{ path: 'src/App.tsx', status: 'modified', additions: 1, deletions: 0 }],
        filesTruncated: false,
        patch: 'diff --git a/src/App.tsx b/src/App.tsx',
        patchTruncated: false,
      })),
      listTests: vi.fn((input: Parameters<BuilderArtifactPort['listTests']>[0]) => Promise.resolve(TestRunsResponseSchema.parse({
        runs: [{
          id: newId('trun'),
          organizationId: input.organizationId,
          runId: input.runId,
          taskId: null,
          commitSha: '2'.repeat(40),
          type: 'browser',
          status: 'passed',
          startedAt: NOW.toISOString(),
          completedAt: NOW.toISOString(),
          summary: { passed: 1 },
          cases: [],
          casesTruncated: false,
        }],
      }))),
      signEvidence: vi.fn((input: Parameters<BuilderArtifactPort['signEvidence']>[0]) => Promise.resolve(SignedVerificationArtifactSchema.parse({
        artifact: {
          id: input.artifactId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: input.runId,
          taskId: input.taskId,
          testRunId: newId('trun'),
          testCaseId: null,
          criterionIds: ['AC-1'],
          kind: 'console',
          description: 'Browser console output',
          contentType: 'application/json',
          byteSize: 12,
          contentHash: 'd'.repeat(64),
          createdAt: NOW.toISOString(),
        },
        download: {
          url: 'https://evidence.example.test/signed',
          expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
        },
      }))),
    };
    const harness = buildHarness({ tenantDb: data.factory, builderArtifacts: artifacts });
    harnesses.push(harness);
    const owner = await signIn(harness, OWNER);
    const organization = await harness.app.inject({
      method: 'POST', url: '/v1/organizations', headers: owner.headers,
      payload: { name: 'Artifacts Org' },
    });
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
    const projectResponse = await harness.app.inject({
      method: 'POST', url: '/v1/projects', headers, payload: { name: 'Artifacts App' },
    });
    const projectId = projectResponse.json<{ project: { id: string } }>().project.id;
    const workspaceId = newId('ws');
    const runId = newId('run');
    const taskId = newId('task');
    const artifactId = newId('art');
    data.workspaces.push({
      id: workspaceId,
      organizationId,
      projectId,
      branchId: null,
      provider: 'modal',
      providerWorkspaceId: 'provider-workspace',
      status: 'ready',
      resourceProfile: 'standard',
      runId: null,
      taskId: null,
      purpose: null,
      environment: null,
      imageTag: null,
      previewMonitorEnabled: false,
      previewMonitorOwnerId: null,
      previewMonitorLeaseExpiresAt: null,
      snapshotRef: null,
      ...EMPTY_WORKSPACE_USAGE,
      createdAt: NOW,
      lastActiveAt: NOW,
      terminatedAt: null,
    } satisfies Workspace);
    data.runs.push({
      id: runId,
      organizationId,
      projectId,
      branchId: null,
      mode: 'build',
      appType: 'web',
      model: 'anthropic/claude-sonnet-5',
      requestFingerprint: 'e'.repeat(64),
      status: 'running',
      specificationId: null,
      temporalWorkflowId: runId,
      startedBy: owner.userId,
      budgetJson: { maxCredits: 100 },
      planMaxCredits: '1000.0000',
      startedAt: NOW,
      completedAt: null,
    } satisfies AgentRun);

    const requests = [
      `/v1/projects/${projectId}/workspaces`,
      `/v1/workspaces/${workspaceId}/files?path=src&maxDepth=2`,
      `/v1/workspaces/${workspaceId}/file?path=src%2FApp.tsx`,
      `/v1/projects/${projectId}/compare?before=${'1'.repeat(40)}&after=${'2'.repeat(40)}`,
      `/v1/runs/${runId}/tests`,
      `/v1/runs/${runId}/evidence/${artifactId}?taskId=${taskId}`,
    ];
    const responses = await Promise.all(requests.map((url) => harness.app.inject({
      method: 'GET', url, headers,
    })));
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(responses[0]?.json()).toMatchObject({ workspaces: [{ id: workspaceId }] });
    expect(responses[4]?.json()).toMatchObject({ runs: [{ runId }] });
    expect(responses[5]?.body).not.toContain('storageRef');
    expect(responses[5]?.body).not.toContain('service-token');

    const editRequest = {
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/edits`,
      headers: { ...headers, 'idempotency-key': 'cp24-edit-1' },
      payload: {
        path: 'src/App.tsx',
        dataBase64: Buffer.from('export default 2;').toString('base64'),
        expectedCompareToken: 'c'.repeat(64),
      },
    } as const;
    const edit = await harness.app.inject(editRequest);
    const replay = await harness.app.inject(editRequest);
    expect(edit.statusCode, edit.body).toBe(200);
    expect(replay.json()).toEqual(edit.json());
    expect(editFile).toHaveBeenCalledTimes(1);
    expect(editFile).toHaveBeenCalledWith(expect.objectContaining({
      organizationId,
      projectId,
      workspaceId,
      actorUserId: owner.userId,
    }));
    expect(editFile.mock.calls[0]?.[0].operationKey).toMatch(/^op_[0-9a-f]{64}$/u);
  });

  it('keeps service credentials inside the workspace and verification HTTP hops', async () => {
    const value = {
      organizationId: newId('org'), projectId: newId('proj'), workspaceId: newId('ws'),
      runId: newId('run'), taskId: newId('task'), artifactId: newId('art'),
    };
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = vi.fn((url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.includes('/editor/edits')) {
        return Promise.resolve(Response.json({
          path: 'src/App.tsx', commitRef: 'a'.repeat(40), compareToken: 'b'.repeat(64),
        }));
      }
      return Promise.resolve(Response.json({
        artifact: {
          id: value.artifactId,
          organizationId: value.organizationId,
          projectId: value.projectId,
          runId: value.runId,
          taskId: value.taskId,
          testRunId: newId('trun'),
          testCaseId: null,
          criterionIds: ['AC-1'],
          kind: 'console',
          description: 'Browser console output',
          contentType: 'application/json',
          byteSize: 12,
          contentHash: 'd'.repeat(64),
          createdAt: NOW.toISOString(),
        },
        download: {
          url: 'https://evidence.example.test/signed',
          expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
        },
      }));
    });
    const client = createBuilderArtifactClient({
      sandboxBaseUrl: 'http://sandbox.internal',
      gitBaseUrl: 'http://git.internal',
      verificationBaseUrl: 'http://verification.internal',
      serviceTokens: { secret: 's'.repeat(64) },
      fetch: doFetch,
    });

    const edit = await client.editFile({
      ...value,
      path: 'src/App.tsx',
      dataBase64: Buffer.from('next').toString('base64'),
      expectedCompareToken: 'c'.repeat(64),
      actorUserId: newId('user'),
      operationKey: 'op_cp24-client',
    });
    const evidence = await client.signEvidence(value);

    expect(edit.commitRef).toBe('a'.repeat(40));
    expect(evidence.artifact).not.toHaveProperty('storageRef');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`http://sandbox.internal/internal/workspaces/${value.workspaceId}/editor/edits`);
    expect(new Headers(requests[0]?.init.headers).get('x-zapp-service-token')).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    expect(requests[0]?.init.body).not.toContain('x-zapp-service-token');
    expect(requests[1]?.url).toContain(`/runs/${value.runId}/artifacts/${value.artifactId}?taskId=${value.taskId}`);
    expect(JSON.stringify(evidence)).not.toContain('service-token');
  });
});
