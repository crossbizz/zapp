import { randomUUID } from 'node:crypto';

import { newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import { loadUsageQueueEnv } from '../../src/env.js';
import { createSqsUsageQueue } from '../../src/usage/outbox.js';
import { credentialGate } from '../support/credentials.js';

const gate = credentialGate([
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]);

if (!gate.present) {
  console.warn(`[@zapp/control-api] LocalStack usage queue test skipped: ${gate.reason}`);
}

describe.skipIf(!gate.present)('OPS-1A LocalStack usage queue', () => {
  it('sends the immutable ledger event body to zapp-usage-events', async () => {
    const config = loadUsageQueueEnv();
    const queue = createSqsUsageQueue(config);
    const eventId = `usage_${randomUUID().replaceAll('-', '')}`;
    const body = JSON.stringify({
      outboxId: `outbox_${eventId}`,
      event: {
        event_name: 'model_input_tokens',
        external_customer_id: newId('org'),
        event_id: eventId,
        timestamp: new Date().toISOString(),
        properties: {
          project_id: newId('proj'),
          run_id: newId('run'),
          task_id: null,
          quantity: 1,
          unit: 'input_tokens',
          provider: 'anthropic',
        },
      },
    });
    try {
      await queue.send(body);
      let received = false;
      for (let attempt = 0; attempt < 5 && !received; attempt += 1) {
        const messages = await queue.receive({
          maxMessages: 10,
          waitTimeSeconds: 1,
          visibilityTimeoutSeconds: 5,
        });
        for (const message of messages) {
          if (message.body === body) {
            received = true;
            await queue.delete(message.receiptHandle);
          }
        }
      }
      expect(received).toBe(true);
    } finally {
      queue.close?.();
    }
  }, 15_000);
});
