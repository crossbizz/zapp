import { afterEach, describe, expect, it } from 'vitest';

import { newId, type StartRunInput } from '@zapp/contracts';
import type { AgentEventRow } from '@zapp/db';

import type { OrchestratorPort } from '../src/orchestrator/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER = {
  externalId: 'conversation-owner',
  email: 'owner@conversations.test',
  displayName: 'Casey Conversation',
} as const;

class RecordingOrchestrator implements OrchestratorPort {
  readonly starts: StartRunInput[] = [];

  startRun(input: StartRunInput): Promise<void> {
    this.starts.push(input);
    return Promise.resolve();
  }

  signalRun(): Promise<{ applied: boolean }> {
    return Promise.resolve({ applied: true });
  }
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly orchestrator: RecordingOrchestrator;
  readonly headers: Record<string, string>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

async function wire(): Promise<Wired> {
  const data = new InMemoryTenantData();
  const orchestrator = new RecordingOrchestrator();
  const built = buildHarness({ tenantDb: data.factory, orchestrator });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const organizationResponse = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Conversation Factory' },
  });
  expect(organizationResponse.statusCode, organizationResponse.body).toBe(201);
  const organizationId = organizationResponse.json<{ organization: { id: string } }>()
    .organization.id;
  const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
  const projectResponse = await built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers,
    payload: { name: 'Durable Chat' },
  });
  expect(projectResponse.statusCode, projectResponse.body).toBe(201);
  return {
    built,
    data,
    owner,
    organizationId,
    projectId: projectResponse.json<{ project: { id: string } }>().project.id,
    orchestrator,
    headers,
  };
}

async function startRun(
  wired: Wired,
  key: string,
  prompt: string,
  conversationId?: string,
): Promise<{ id: string; conversationId: string; conversationRunNumber: number }> {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${wired.projectId}/runs`,
    headers: { ...wired.headers, 'idempotency-key': key },
    payload: {
      mode: 'build',
      prompt,
      ...(conversationId === undefined ? {} : { conversationId }),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const created = response.json<{
    run: { id: string; conversationId: string; conversationRunNumber: number };
    conversation: { id: string; projectId: string; title: string };
  }>();
  expect(created.conversation).toMatchObject({
    id: created.run.conversationId,
    projectId: wired.projectId,
  });
  return created.run;
}

function addMessage(
  wired: Wired,
  runId: string,
  sequence: number,
  type: 'message.user' | 'message.assistant',
  content: string,
): void {
  const row: AgentEventRow = {
    id: newId('evt'),
    organizationId: wired.organizationId,
    projectId: wired.projectId,
    runId,
    sequence,
    phaseId: null,
    taskId: null,
    agentId: null,
    type,
    payloadJson:
      type === 'message.user'
        ? { messageId: `msg_${'1'.repeat(26)}`, content, attachments: [], source: 'web' }
        : {
            messageId: `msg_${'2'.repeat(26)}`,
            turnId: `turn_${'3'.repeat(26)}`,
            content,
            model: 'anthropic/claude-sonnet-5',
          },
    visibility: 'user',
    occurredAt: new Date(`2026-08-16T12:00:0${String(sequence)}.000Z`),
  };
  wired.data.events.push(row);
}

describe('durable project conversations', () => {
  it('lists one conversation and ordered events across successor runs', async () => {
    const wired = await wire();
    const first = await startRun(wired, 'conversation-first', 'Build the first version');
    addMessage(wired, first.id, 1, 'message.user', 'Build the first version');
    addMessage(wired, first.id, 2, 'message.assistant', 'The first version is ready.');
    const storedFirst = wired.data.runs.find((run) => run.id === first.id);
    expect(storedFirst).toBeDefined();
    if (storedFirst === undefined) throw new Error('first run was not stored');
    wired.data.runs.splice(wired.data.runs.indexOf(storedFirst), 1, {
      ...storedFirst,
      status: 'completed',
      completedAt: new Date('2026-08-16T12:01:00.000Z'),
    });

    const second = await startRun(
      wired,
      'conversation-second',
      'Now add team invitations',
      first.conversationId,
    );
    addMessage(wired, second.id, 1, 'message.user', 'Now add team invitations');

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      conversationRunNumber: 2,
    });
    expect(wired.orchestrator.starts[1]).toMatchObject({
      conversationId: first.conversationId,
    });
    expect(wired.orchestrator.starts[1]?.conversationContextArtifactId).toMatch(/^art_/u);
    expect(wired.orchestrator.starts[1]?.priorConversationContext).toContain(
      'Prior conversation context',
    );
    expect(wired.orchestrator.starts[1]?.priorConversationContext).toContain(
      'Build the first version',
    );
    expect(wired.orchestrator.starts[1]?.priorConversationContext).toContain(
      'The first version is ready.',
    );

    const summaries = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/conversations`,
      headers: wired.headers,
    });
    expect(summaries.statusCode, summaries.body).toBe(200);
    expect(summaries.json()).toMatchObject({
      items: [
        {
          id: first.conversationId,
          title: 'Build the first version',
          latestRun: { id: second.id, status: 'queued' },
          runCount: 2,
        },
      ],
      nextCursor: null,
    });

    const history = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/conversations/${first.conversationId}/events`,
      headers: wired.headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(
      history
        .json<{ items: { runNumber: number; event: { sequence: number } }[] }>()
        .items.map((item) => [item.runNumber, item.event.sequence]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
  });

  it('creates a separate conversation only when conversationId is omitted', async () => {
    const wired = await wire();
    const first = await startRun(wired, 'thread-one', 'Create the client portal');
    const second = await startRun(wired, 'thread-two', 'Explore a separate admin app');

    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.conversationRunNumber).toBe(1);
  });

  it('rejects a concurrent successor and hides unknown conversations', async () => {
    const wired = await wire();
    const first = await startRun(wired, 'active-thread', 'Keep this run active');
    const conflict = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/runs`,
      headers: { ...wired.headers, 'idempotency-key': 'active-thread-successor' },
      payload: {
        mode: 'build',
        prompt: 'This must not create a concurrent writer',
        conversationId: first.conversationId,
      },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe(
      'conversation_run_active',
    );

    const missing = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/conversations/${newId('conv')}/events`,
      headers: wired.headers,
    });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe(
      'conversation_not_found',
    );
  });

  it('scopes deterministic run and conversation ids to the tenant', async () => {
    const wired = await wire();
    const sharedKey = 'same-key-across-organizations';
    const first = await startRun(wired, sharedKey, 'Build the first tenant app');
    const secondOrganization = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: wired.owner.headers,
      payload: { name: 'Second Conversation Factory' },
    });
    expect(secondOrganization.statusCode, secondOrganization.body).toBe(201);
    const secondOrganizationId = secondOrganization.json<{ organization: { id: string } }>()
      .organization.id;
    const secondHeaders = {
      ...wired.owner.headers,
      [ORGANIZATION_HEADER]: secondOrganizationId,
    };
    const secondProject = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: secondHeaders,
      payload: { name: 'Second Durable Chat' },
    });
    expect(secondProject.statusCode, secondProject.body).toBe(201);
    const secondProjectId = secondProject.json<{ project: { id: string } }>().project.id;
    const secondRun = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${secondProjectId}/runs`,
      headers: { ...secondHeaders, 'idempotency-key': sharedKey },
      payload: { mode: 'build', prompt: 'Build the second tenant app' },
    });
    expect(secondRun.statusCode, secondRun.body).toBe(201);
    const second = secondRun.json<{
      run: { id: string; conversationId: string };
      conversation: { id: string };
    }>();

    expect(second.run.id).not.toBe(first.id);
    expect(second.run.conversationId).not.toBe(first.conversationId);
    expect(second.conversation.id).toBe(second.run.conversationId);
  });
});
