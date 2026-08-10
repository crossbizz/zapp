import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../../src/auth/port.js';
import type { OrchestratorPort, SignalRunInput } from '../../src/orchestrator/port.js';
import { ORGANIZATION_HEADER } from '../../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from '../support/harness.js';
import { InMemoryTenantData } from '../support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'conversation-owner',
  email: 'owner@conversation.test',
  displayName: 'Conversation Owner',
};

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

class RecordingOrchestrator implements OrchestratorPort {
  readonly signals: SignalRunInput[] = [];

  startRun(): Promise<void> {
    return Promise.resolve();
  }

  signalRun(input: SignalRunInput): Promise<{ applied: boolean }> {
    this.signals.push(input);
    return Promise.resolve({ applied: true });
  }
}

class MemoryAttachmentStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  put(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
    return Promise.resolve();
  }

  signGet(input: { key: string }): Promise<string> {
    return Promise.resolve(`https://attachments.zapp.test/${encodeURIComponent(input.key)}?ttl=300`);
  }
}

interface Wired {
  readonly harness: Harness;
  readonly data: InMemoryTenantData;
  readonly orchestrator: RecordingOrchestrator;
  readonly storage: MemoryAttachmentStorage;
  readonly headers: Record<string, string>;
  readonly organizationId: string;
}

async function wire(): Promise<Wired> {
  const data = new InMemoryTenantData();
  const orchestrator = new RecordingOrchestrator();
  const storage = new MemoryAttachmentStorage();
  const harness = buildHarness({
    tenantDb: data.factory,
    orchestrator,
    attachmentStorage: storage,
  });
  harnesses.push(harness);
  const owner = await signIn(harness, OWNER);
  const created = await harness.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Conversation Org' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json<{ organization: { id: string } }>().organization.id;
  return {
    harness,
    data,
    orchestrator,
    storage,
    organizationId,
    headers: { ...owner.headers, [ORGANIZATION_HEADER]: organizationId },
  };
}

async function createRun(wired: Wired): Promise<{ projectId: string; runId: string }> {
  const projectResponse = await wired.harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { ...wired.headers, 'idempotency-key': 'conversation-project' },
    payload: { name: 'Conversation Project' },
  });
  expect(projectResponse.statusCode, projectResponse.body).toBe(201);
  const projectId = projectResponse.json<{ project: { id: string } }>().project.id;
  const runResponse = await wired.harness.app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/runs`,
    headers: { ...wired.headers, 'idempotency-key': 'conversation-run' },
    payload: { mode: 'build', prompt: 'Build a landing page' },
  });
  expect(runResponse.statusCode, runResponse.body).toBe(201);
  return {
    projectId,
    runId: runResponse.json<{ run: { id: string } }>().run.id,
  };
}

function multipart(filename: string, contentType: string, body: Buffer): {
  readonly payload: Buffer;
  readonly contentType: string;
} {
  const boundary = 'zapp-attachment-boundary';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe('public conversation continuation', () => {
  it('replays an idempotent message with one event, one sequence and one workflow signal', async () => {
    const wired = await wire();
    const { runId } = await createRun(wired);
    const request = {
      method: 'POST' as const,
      url: `/v1/runs/${runId}/messages`,
      headers: { ...wired.headers, 'idempotency-key': 'message-1' },
      payload: { content: 'Make the hero more concise.' },
    };
    const first = await wired.harness.app.inject(request);
    const replay = await wired.harness.app.inject(request);

    expect(first.statusCode, first.body).toBe(202);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(wired.data.events.filter((event) => event.type === 'message.user')).toHaveLength(1);
    expect(wired.data.events.at(-1)?.sequence).toBe(first.json<{ sequence: number }>().sequence);
    expect(wired.orchestrator.signals).toHaveLength(1);
    expect(wired.orchestrator.signals[0]).toMatchObject({ signal: 'message' });
  });

  it('returns run_not_active for a completed run without writing or signalling', async () => {
    const wired = await wire();
    const { runId } = await createRun(wired);
    const index = wired.data.runs.findIndex((run) => run.id === runId);
    const run = wired.data.runs[index];
    if (run === undefined) throw new Error('seeded run missing');
    wired.data.runs.splice(index, 1, { ...run, status: 'completed', completedAt: new Date() });

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/messages`,
      headers: { ...wired.headers, 'idempotency-key': 'message-completed' },
      payload: { content: 'One more change.' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('run_not_active');
    expect(wired.data.events).toHaveLength(0);
    expect(wired.orchestrator.signals).toHaveLength(0);
  });

  it('returns 404 for another tenant run id', async () => {
    const wired = await wire();
    const { runId } = await createRun(wired);
    const second = await wired.harness.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: Object.fromEntries(
        Object.entries(wired.headers).filter(([name]) => name !== ORGANIZATION_HEADER),
      ),
      payload: { name: 'Other Org' },
    });
    expect(second.statusCode, second.body).toBe(201);
    const otherOrganizationId = second.json<{ organization: { id: string } }>().organization.id;

    const response = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/messages`,
      headers: {
        ...wired.headers,
        [ORGANIZATION_HEADER]: otherOrganizationId,
        'idempotency-key': 'cross-tenant-message',
      },
      payload: { content: 'Probe another run.' },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(wired.orchestrator.signals).toHaveLength(0);
  });
});

describe('public image attachments', () => {
  it('uploads an allowlisted image and returns a short-lived signed download URL', async () => {
    const wired = await wire();
    const { projectId, runId } = await createRun(wired);
    const form = multipart('reference.png', 'image/png', Buffer.from('png-bytes'));
    const uploaded = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/attachments`,
      headers: {
        ...wired.headers,
        'idempotency-key': 'attachment-1',
        'content-type': form.contentType,
      },
      payload: form.payload,
    });

    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const attachment = uploaded.json<{ attachmentId: string; byteSize: number; contentType: string }>();
    expect(attachment).toMatchObject({ byteSize: 9, contentType: 'image/png' });
    expect(wired.storage.objects).toHaveLength(1);

    const changed = multipart('reference.png', 'image/png', Buffer.from('different-png'));
    const conflict = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/attachments`,
      headers: {
        ...wired.headers,
        'idempotency-key': 'attachment-1',
        'content-type': changed.contentType,
      },
      payload: changed.payload,
    });
    expect(conflict.statusCode, conflict.body).toBe(422);
    expect(wired.storage.objects).toHaveLength(1);

    const continued = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/messages`,
      headers: { ...wired.headers, 'idempotency-key': 'message-with-attachment' },
      payload: { content: 'Use this reference.', attachments: [attachment] },
    });
    expect(continued.statusCode, continued.body).toBe(202);
    expect(wired.data.events.slice(-2).map((event) => event.type)).toEqual([
      'artifact.created',
      'message.user',
    ]);
    expect(wired.data.events.at(-2)?.payloadJson).toMatchObject({
      artifactId: attachment.attachmentId,
      type: 'image_attachment',
    });
    expect(continued.json<{ sequence: number }>().sequence).toBe(
      wired.data.events.at(-1)?.sequence,
    );

    const downloaded = await wired.harness.app.inject({
      method: 'GET',
      url: `/v1/attachments/${attachment.attachmentId}`,
      headers: wired.headers,
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.json<{ url: string }>().url).toContain('ttl=300');
  });

  it('rejects non-image content and an image larger than 8 MiB', async () => {
    const wired = await wire();
    const { projectId } = await createRun(wired);
    const text = multipart('notes.txt', 'text/plain', Buffer.from('not an image'));
    const disallowed = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/attachments`,
      headers: {
        ...wired.headers,
        'idempotency-key': 'attachment-text',
        'content-type': text.contentType,
      },
      payload: text.payload,
    });
    expect(disallowed.statusCode, disallowed.body).toBe(415);

    const large = multipart('large.png', 'image/png', Buffer.alloc(8 * 1024 * 1024 + 1));
    const oversized = await wired.harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/attachments`,
      headers: {
        ...wired.headers,
        'idempotency-key': 'attachment-large',
        'content-type': large.contentType,
      },
      payload: large.payload,
    });
    expect(oversized.statusCode, oversized.body).toBe(413);
    expect(wired.storage.objects).toHaveLength(0);
  });
});
