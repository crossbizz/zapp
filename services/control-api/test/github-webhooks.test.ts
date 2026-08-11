import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitHubWebhookPublisher,
  createInMemoryGitHubWebhookStore,
  type GitHubWebhookQueuePort,
} from '../src/integrations/github/queue.js';
import { buildHarness, type Harness } from './support/harness.js';

const SECRET = 'test-webhook-secret-not-a-real-credential';
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

function signature(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')}`;
}

function request(
  harness: Harness,
  input: { body: string; delivery?: string; event?: string; signature?: string },
) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      ...(input.delivery === undefined ? {} : { 'x-github-delivery': input.delivery }),
      ...(input.event === undefined ? {} : { 'x-github-event': input.event }),
      ...(input.signature === undefined ? {} : { 'x-hub-signature-256': input.signature }),
    },
    payload: input.body,
  });
}

describe('GitHub webhook receipt and durable publishing', () => {
  it('rejects missing or invalid signatures before parsing or enqueueing', async () => {
    const store = createInMemoryGitHubWebhookStore();
    const harness = buildHarness({ githubWebhook: { secret: SECRET, store } });
    harnesses.push(harness);
    const malformed = '{not-json';

    const missing = await request(harness, {
      body: malformed,
      delivery: 'delivery-missing-signature',
      event: 'push',
    });
    expect(missing.statusCode).toBe(401);
    const invalid = await request(harness, {
      body: malformed,
      delivery: 'delivery-invalid-signature',
      event: 'push',
      signature: 'sha256=' + '0'.repeat(64),
    });
    expect(invalid.statusCode).toBe(401);

    const sent: string[] = [];
    const publisher = createGitHubWebhookPublisher({
      store,
      queue: { send: (body) => { sent.push(body); return Promise.resolve(); } },
    });
    expect(await publisher.publishOnce(10)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('claims supported deliveries once and treats unknown events as successful no-ops', async () => {
    const store = createInMemoryGitHubWebhookStore();
    const harness = buildHarness({ githubWebhook: { secret: SECRET, store } });
    harnesses.push(harness);
    const body = '{ "installation": { "id": 41122 }, "ref": "refs/heads/main" }';
    const headers = {
      body,
      delivery: 'delivery-supported-1',
      event: 'push',
      signature: signature(body),
    };

    expect((await request(harness, headers)).statusCode).toBe(202);
    expect((await request(harness, headers)).statusCode).toBe(202);
    for (const event of ['pull_request', 'installation']) {
      expect((await request(harness, {
        ...headers,
        delivery: `delivery-${event}-1`,
        event,
      })).statusCode).toBe(202);
    }
    const unknownBody = JSON.stringify({ secretShape: 'not-persisted' });
    expect((await request(harness, {
      body: unknownBody,
      delivery: 'delivery-unknown-1',
      event: 'issues',
      signature: signature(unknownBody),
    })).statusCode).toBe(202);

    const sent: string[] = [];
    const publisher = createGitHubWebhookPublisher({
      store,
      queue: { send: (message) => { sent.push(message); return Promise.resolve(); } },
    });
    expect(await publisher.publishOnce(10)).toBe(3);
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[0] ?? '')).toEqual({
      deliveryId: 'delivery-supported-1',
      eventName: 'push',
      installationId: '41122',
      payload: { installation: { id: 41122 }, ref: 'refs/heads/main' },
    });
    expect(sent[0]).not.toContain('sha256=');
    expect(await publisher.publishOnce(10)).toBe(0);
  });

  it('keeps a failed publish pending and settles it after replay', async () => {
    let now = new Date('2026-08-10T12:00:00.000Z');
    const store = createInMemoryGitHubWebhookStore();
    const harness = buildHarness({ githubWebhook: { secret: SECRET, store, now: () => now } });
    harnesses.push(harness);
    const body = JSON.stringify({ installation: { id: 41122 }, action: 'created' });
    expect((await request(harness, {
      body,
      delivery: 'delivery-retry-1',
      event: 'installation',
      signature: signature(body),
    })).statusCode).toBe(202);

    const sent: string[] = [];
    let fail = true;
    const queue: GitHubWebhookQueuePort = {
      send(message) {
        if (fail) return Promise.reject(new Error('queue unavailable'));
        sent.push(message);
        return Promise.resolve();
      },
    };
    const publisher = createGitHubWebhookPublisher({ store, queue, now: () => now });
    expect(await publisher.publishOnce(10)).toBe(0);
    expect(sent).toEqual([]);
    fail = false;
    now = new Date(now.getTime() + 1_000);
    expect(await publisher.publishOnce(10)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await publisher.publishOnce(10)).toBe(0);
  });
});
