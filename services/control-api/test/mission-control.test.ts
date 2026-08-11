import { newId, type AgentEventType, type AgentEventVisibility } from '@zapp/contracts';
import type { AgentEventRow, AgentRun } from '@zapp/db';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'mission-control-owner',
  email: 'owner@mission-control.test',
  displayName: 'Mira Mission',
};

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.app.close()));
});

interface SeededRun {
  readonly harness: Harness;
  readonly data: InMemoryTenantData;
  readonly organizationId: string;
  readonly projectId: string;
  readonly run: AgentRun;
  readonly headers: Record<string, string>;
}

async function seedRun(): Promise<SeededRun> {
  const data = new InMemoryTenantData();
  const harness = buildHarness({ tenantDb: data.factory });
  harnesses.push(harness);
  const owner = await signIn(harness, OWNER);
  const organization = await harness.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Mission Control Org' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
  const projectResponse = await harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers,
    payload: { name: 'Mission Control App' },
  });
  expect(projectResponse.statusCode, projectResponse.body).toBe(201);
  const projectId = projectResponse.json<{ project: { id: string } }>().project.id;
  const run: AgentRun = {
    id: newId('run'),
    organizationId,
    projectId,
    branchId: null,
    mode: 'build',
    appType: 'web',
    model: 'anthropic/claude-sonnet-5',
    requestFingerprint: 'a'.repeat(64),
    status: 'running',
    specificationId: null,
    temporalWorkflowId: newId('run'),
    startedBy: owner.userId,
    budgetJson: { maxCredits: 100 },
    planMaxCredits: '1000.0000',
    startedAt: new Date('2026-08-09T18:00:00.000Z'),
    completedAt: null,
  };
  data.runs.push(run);
  return { harness, data, organizationId, projectId, run, headers };
}

function addEvent(
  seeded: SeededRun,
  type: AgentEventType,
  payloadJson: Record<string, unknown>,
  options: {
    readonly visibility?: AgentEventVisibility;
    readonly phaseId?: string;
    readonly taskId?: string;
    readonly agentId?: string;
  } = {},
): AgentEventRow {
  const sequence = seeded.data.events.length + 1;
  const row: AgentEventRow = {
    id: newId('evt'),
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
    runId: seeded.run.id,
    sequence,
    type,
    payloadJson,
    visibility: options.visibility ?? 'user',
    occurredAt: new Date(`2026-08-09T18:00:${String(sequence).padStart(2, '0')}.000Z`),
    phaseId: options.phaseId ?? null,
    taskId: options.taskId ?? null,
    agentId: options.agentId ?? null,
  };
  seeded.data.events.push(row);
  return row;
}

describe('GET /v1/runs/:runId/mission-control', () => {
  it('builds the user read model from the run row and visible immutable events', async () => {
    const seeded = await seedRun();
    const phaseId = newId('phase');
    const taskOne = newId('task');
    const taskTwo = newId('task');
    const pendingApproval = newId('appr');
    const resolvedApproval = newId('appr');
    const screenshotId = newId('art');
    const testRunId = newId('trun');
    const verificationId = newId('vr');

    addEvent(seeded, 'run.started', {});
    addEvent(
      seeded,
      'phase.created',
      { phaseId, sequence: 1, title: 'Build checkout', status: 'queued' },
      { phaseId },
    );
    addEvent(
      seeded,
      'phase.started',
      { phaseId, sequence: 1, title: 'Build checkout', status: 'running' },
      { phaseId },
    );
    addEvent(
      seeded,
      'task.created',
      {
        taskId: taskOne,
        phaseId,
        title: 'Create checkout form',
        status: 'running',
        riskLevel: 'medium',
        dependencies: [],
        assignedAgentRole: 'builder',
      },
      { phaseId, taskId: taskOne },
    );
    addEvent(
      seeded,
      'task.created',
      {
        taskId: taskTwo,
        phaseId,
        title: 'Verify checkout',
        status: 'queued',
        riskLevel: 'low',
        dependencies: [taskOne],
        assignedAgentRole: 'verifier',
      },
      { phaseId, taskId: taskTwo },
    );
    addEvent(
      seeded,
      'agent.started',
      { agentId: 'builder-primary', role: 'builder', taskId: taskOne },
      { taskId: taskOne, agentId: 'builder-primary' },
    );
    addEvent(
      seeded,
      'tool.completed',
      {
        toolCallId: 'tool-user',
        toolName: 'write_file',
        status: 'completed',
        userSummary: 'Updated the checkout form',
        durationMs: 42,
      },
      { taskId: taskOne, agentId: 'builder-primary' },
    );
    addEvent(
      seeded,
      'tool.completed',
      {
        toolCallId: 'tool-internal',
        toolName: 'read_secret_metadata',
        status: 'completed',
        userSummary: 'must not be returned',
      },
      { visibility: 'internal', taskId: taskOne, agentId: 'builder-primary' },
    );
    addEvent(
      seeded,
      'commit.created',
      {
        sha: '0123456789abcdef0123456789abcdef01234567',
        message: 'feat: build checkout',
        diffstat: [
          { path: 'src/checkout.tsx', additions: 24, deletions: 3 },
          { path: 'src/cart.ts', additions: 2, deletions: 1 },
        ],
      },
      { taskId: taskOne },
    );
    addEvent(
      seeded,
      'test.completed',
      {
        testRunId,
        type: 'unit',
        status: 'passed',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        summary: { passed: 12, failed: 0 },
      },
      { taskId: taskOne },
    );
    addEvent(seeded, 'artifact.created', {
      artifactId: screenshotId,
      type: 'screenshot',
      storageRef: `${seeded.organizationId}/${seeded.projectId}/checkout.png`,
      contentHash: 'b'.repeat(64),
    });
    addEvent(seeded, 'preview.ready', { status: 'ready' });
    addEvent(seeded, 'usage.recorded', { creditsCharged: '99.0000' });
    addEvent(seeded, 'approval.requested', {
      approvalId: pendingApproval,
      type: 'tool',
      status: 'pending',
      request: { toolName: 'deploy_preview' },
    });
    addEvent(seeded, 'approval.requested', {
      approvalId: resolvedApproval,
      type: 'risk',
      status: 'pending',
      request: { summary: 'Change checkout route' },
    });
    addEvent(seeded, 'approval.resolved', {
      approvalId: resolvedApproval,
      status: 'approved',
      response: { note: 'Reviewed' },
      resolvedBy: seeded.run.startedBy,
    });
    addEvent(seeded, 'verification.completed', {
      verificationId,
      decision: 'approved_with_risks',
      risks: [],
    });
    addEvent(
      seeded,
      'task.completed',
      { taskId: taskOne, status: 'completed' },
      { phaseId, taskId: taskOne },
    );

    seeded.data.phases.push({
      id: phaseId,
      organizationId: seeded.organizationId,
      runId: seeded.run.id,
      sequence: 1,
      title: 'Build checkout',
      status: 'running',
      acceptanceCriteriaJson: [],
    });
    seeded.data.tasks.push(
      {
        id: taskOne,
        organizationId: seeded.organizationId,
        phaseId,
        parentTaskId: null,
        title: 'Create checkout form',
        status: 'passed',
        riskLevel: 'medium',
        baseCommitSha: null,
        outputCommitSha: '0123456789abcdef0123456789abcdef01234567',
        acceptanceCriteriaJson: [],
        dependenciesJson: [],
        assignedAgentRole: 'builder',
      },
      {
        id: taskTwo,
        organizationId: seeded.organizationId,
        phaseId,
        parentTaskId: null,
        title: 'Verify checkout',
        status: 'queued',
        riskLevel: 'low',
        baseCommitSha: null,
        outputCommitSha: null,
        acceptanceCriteriaJson: [],
        dependenciesJson: [taskOne],
        assignedAgentRole: 'verifier',
      },
    );
    seeded.data.approvals.push(
      {
        id: pendingApproval,
        organizationId: seeded.organizationId,
        runId: seeded.run.id,
        taskId: null,
        type: 'tool',
        status: 'pending',
        requestJson: { toolName: 'deploy_preview' },
        responseJson: null,
        requestedAt: new Date('2026-08-09T18:00:14.000Z'),
        resolvedAt: null,
        resolvedBy: null,
      },
      {
        id: resolvedApproval,
        organizationId: seeded.organizationId,
        runId: seeded.run.id,
        taskId: null,
        type: 'risk',
        status: 'approved',
        requestJson: { summary: 'Change checkout route' },
        responseJson: { note: 'Reviewed' },
        requestedAt: new Date('2026-08-09T18:00:15.000Z'),
        resolvedAt: new Date('2026-08-09T18:00:16.000Z'),
        resolvedBy: seeded.run.startedBy,
      },
    );
    seeded.data.artifacts.push({
      id: screenshotId,
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      runId: seeded.run.id,
      taskId: null,
      type: 'screenshot',
      storageRef: `${seeded.organizationId}/${seeded.projectId}/checkout.png`,
      contentHash: 'b'.repeat(64),
      metadataJson: {},
      createdAt: new Date('2026-08-09T18:00:11.000Z'),
    });
    seeded.data.testRuns.push({
      id: testRunId,
      organizationId: seeded.organizationId,
      runId: seeded.run.id,
      taskId: taskOne,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      type: 'unit',
      status: 'passed',
      startedAt: new Date('2026-08-09T18:00:09.000Z'),
      completedAt: new Date('2026-08-09T18:00:10.000Z'),
      summaryJson: { passed: 12, failed: 0 },
    });
    seeded.data.verificationResults.push({
      id: verificationId,
      organizationId: seeded.organizationId,
      runId: seeded.run.id,
      taskId: taskOne,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      decision: 'approved_with_risks',
      criteriaResultsJson: [],
      risksJson: [
        { id: 'risk-checkout', severity: 'medium', summary: 'Add browser coverage' },
      ],
      createdAt: new Date('2026-08-09T18:00:17.000Z'),
    });
    seeded.data.creditAccounts.push({
      runId: seeded.run.id,
      organizationId: seeded.organizationId,
      baseCeiling: '100.0000',
      pricingVersion: 'm1-test',
      pricingSnapshotJson: {},
      usedCredits: '12.5000',
      reservedCredits: '0.0000',
      version: 1,
      updatedAt: new Date('2026-08-09T18:00:18.000Z'),
    });
    seeded.data.creditCeilingAdjustments.push({
      id: 'ceiling-adjustment-1',
      organizationId: seeded.organizationId,
      runId: seeded.run.id,
      approvalId: resolvedApproval,
      operationKey: 'mission-control-approved-ceiling',
      absoluteCeiling: '125.0000',
      createdAt: new Date('2026-08-09T18:00:19.000Z'),
    });

    const response = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${seeded.run.id}/mission-control`,
      headers: seeded.headers,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('tool-internal');
    expect(response.body).not.toContain('must not be returned');
    expect(response.json()).toMatchInlineSnapshot(`
      {
        "activeAgents": [
          {
            "agentId": "builder-primary",
            "role": "builder",
            "startedAt": "2026-08-09T18:00:06.000Z",
            "taskId": "${taskOne}",
          },
        ],
        "approvals": [
          {
            "approvalId": "${pendingApproval}",
            "request": {
              "toolName": "deploy_preview",
            },
            "requestedAt": "2026-08-09T18:00:14.000Z",
            "resolvedAt": null,
            "response": null,
            "status": "pending",
            "taskId": null,
            "type": "tool",
          },
          {
            "approvalId": "${resolvedApproval}",
            "request": {
              "summary": "Change checkout route",
            },
            "requestedAt": "2026-08-09T18:00:15.000Z",
            "resolvedAt": "2026-08-09T18:00:16.000Z",
            "response": {
              "note": "Reviewed",
            },
            "status": "approved",
            "taskId": null,
            "type": "risk",
          },
        ],
        "commits": [
          {
            "diffstat": [
              {
                "additions": 24,
                "deletions": 3,
                "path": "src/checkout.tsx",
              },
              {
                "additions": 2,
                "deletions": 1,
                "path": "src/cart.ts",
              },
            ],
            "message": "feat: build checkout",
            "occurredAt": "2026-08-09T18:00:09.000Z",
            "sequence": 9,
            "sha": "0123456789abcdef0123456789abcdef01234567",
            "taskId": "${taskOne}",
          },
        ],
        "cost": {
          "budget": 125,
          "creditsUsed": 12.5,
        },
        "currentPhase": {
          "id": "${phaseId}",
          "sequence": 1,
          "status": "running",
          "title": "Build checkout",
        },
        "filesChanged": [
          {
            "additions": 2,
            "deletions": 1,
            "path": "src/cart.ts",
          },
          {
            "additions": 24,
            "deletions": 3,
            "path": "src/checkout.tsx",
          },
        ],
        "previewStatus": {
          "occurredAt": "2026-08-09T18:00:12.000Z",
          "status": "ready",
        },
        "progress": {
          "done": 1,
          "total": 2,
        },
        "recentToolCalls": [
          {
            "agentId": "builder-primary",
            "durationMs": 42,
            "occurredAt": "2026-08-09T18:00:07.000Z",
            "sequence": 7,
            "status": "completed",
            "taskId": "${taskOne}",
            "toolCallId": "tool-user",
            "toolName": "write_file",
            "userSummary": "Updated the checkout form",
          },
        ],
        "risks": [
          {
            "id": "risk-checkout",
            "severity": "medium",
            "summary": "Add browser coverage",
          },
        ],
        "run": {
          "appType": "web",
          "branchId": null,
          "completedAt": null,
          "id": "${seeded.run.id}",
          "mode": "build",
          "model": "anthropic/claude-sonnet-5",
          "organizationId": "${seeded.organizationId}",
          "planMaxCredits": "1000.0000",
          "projectId": "${seeded.projectId}",
          "startedAt": "2026-08-09T18:00:00.000Z",
          "startedBy": "${seeded.run.startedBy}",
          "status": "running",
        },
        "screenshots": [
          {
            "artifactId": "${screenshotId}",
            "contentHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "createdAt": "2026-08-09T18:00:11.000Z",
          },
        ],
        "taskGraph": {
          "edges": [
            {
              "from": "${taskOne}",
              "to": "${taskTwo}",
            },
          ],
          "nodes": [
            {
              "assignedAgentRole": "builder",
              "id": "${taskOne}",
              "phaseId": "${phaseId}",
              "riskLevel": "medium",
              "status": "passed",
              "title": "Create checkout form",
            },
            {
              "assignedAgentRole": "verifier",
              "id": "${taskTwo}",
              "phaseId": "${phaseId}",
              "riskLevel": "low",
              "status": "queued",
              "title": "Verify checkout",
            },
          ],
        },
        "testRuns": [
          {
            "commitSha": "0123456789abcdef0123456789abcdef01234567",
            "occurredAt": "2026-08-09T18:00:10.000Z",
            "status": "passed",
            "summary": {
              "failed": 0,
              "passed": 12,
            },
            "taskId": "${taskOne}",
            "testRunId": "${testRunId}",
            "type": "unit",
          },
        ],
      }
    `);
  });

  it('does not report an agent as active after the production run terminal event', async () => {
    const seeded = await seedRun();
    addEvent(seeded, 'agent.started', { agent: 'builder' }, { agentId: 'builder' });
    addEvent(seeded, 'run.completed', { status: 'completed' });

    const response = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${seeded.run.id}/mission-control`,
      headers: seeded.headers,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ activeAgents: unknown[] }>().activeAgents).toEqual([]);
  });

  it('caps the aggregate at 50 tool calls and keyset-paginates tool calls and commits', async () => {
    const seeded = await seedRun();
    for (let index = 1; index <= 52; index += 1) {
      addEvent(seeded, 'tool.completed', {
        toolCallId: `tool-${String(index).padStart(2, '0')}`,
        toolName: 'read_file',
        status: 'completed',
        userSummary: `Read ${String(index)}`,
      });
    }
    addEvent(seeded, 'tool.completed', {
      toolCallId: 'tool-hidden',
      toolName: 'internal_trace',
      status: 'completed',
      userSummary: 'hidden',
    }, { visibility: 'internal' });
    addEvent(seeded, 'commit.created', {
      sha: '1'.repeat(40),
      message: 'first',
      diffstat: [],
    });
    addEvent(seeded, 'commit.created', {
      sha: '2'.repeat(40),
      message: 'second',
      diffstat: [],
    });

    const aggregate = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${seeded.run.id}/mission-control`,
      headers: seeded.headers,
    });
    expect(aggregate.statusCode, aggregate.body).toBe(200);
    const recent = aggregate.json<{ recentToolCalls: { toolCallId: string }[] }>().recentToolCalls;
    expect(recent).toHaveLength(50);
    expect(recent[0]?.toolCallId).toBe('tool-52');
    expect(recent.at(-1)?.toolCallId).toBe('tool-03');
    expect(aggregate.body).not.toContain('tool-hidden');

    const firstTools = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${seeded.run.id}/mission-control/tool-calls?limit=2`,
      headers: seeded.headers,
    });
    expect(firstTools.statusCode, firstTools.body).toBe(200);
    const firstToolPage = firstTools.json<{
      items: { sequence: number; toolCallId: string }[];
      nextCursor: string | null;
    }>();
    expect(firstToolPage.items.map((item) => item.toolCallId)).toEqual(['tool-52', 'tool-51']);
    expect(firstToolPage.nextCursor).toBe(String(firstToolPage.items[1]?.sequence));

    const secondTools = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${seeded.run.id}/mission-control/tool-calls?limit=2&cursor=${firstToolPage.nextCursor ?? ''}`,
      headers: seeded.headers,
    });
    expect(secondTools.statusCode, secondTools.body).toBe(200);
    expect(secondTools.json<{ items: { toolCallId: string }[] }>().items).toEqual([
      expect.objectContaining({ toolCallId: 'tool-50' }),
      expect.objectContaining({ toolCallId: 'tool-49' }),
    ]);

    const commits = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${seeded.run.id}/mission-control/commits?limit=1`,
      headers: seeded.headers,
    });
    expect(commits.statusCode, commits.body).toBe(200);
    const commitPage = commits.json<{
      items: { sha: string; message: string }[];
      nextCursor: string | null;
    }>();
    expect(commitPage.items).toEqual([
      expect.objectContaining({ sha: '2'.repeat(40), message: 'second' }),
    ]);
    expect(commitPage.nextCursor).toEqual(expect.any(String));
  });

  it('returns 404 without reading events for a run outside the tenant', async () => {
    const seeded = await seedRun();
    const foreignRunId = newId('run');
    addEvent(seeded, 'tool.completed', {
      toolCallId: 'tool-owned',
      toolName: 'read_file',
      status: 'completed',
      userSummary: 'owned',
    });

    const response = await seeded.harness.app.inject({
      method: 'GET',
      url: `/v1/runs/${foreignRunId}/mission-control`,
      headers: seeded.headers,
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('run_not_found');
  });
});
