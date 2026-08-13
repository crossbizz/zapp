import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { loadNotificationEnv } from '../../src/env.js';
import { createSesEmailSender, createSqsNotificationQueue } from '../../src/notifications/email.js';
import {
  createInMemoryNotificationState,
  createNotificationProducer,
  createNotificationWorker,
  createRedisNotificationState,
  type NotificationQueuePort,
} from '../../src/notifications/service.js';
import { createRedisConnection } from '../../src/redis/client.js';
import { credentialGate } from '../support/credentials.js';

const gate = credentialGate([
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'SQS_NOTIFICATION_QUEUE_NAME',
  'SES_NOTIFICATION_SOURCE',
  'SNS_NOTIFICATION_TOPIC_ARN',
]);
if (!gate.present) {
  console.warn(`[@zapp/control-api] OPS-7 LocalStack notification test skipped: ${gate.reason}`);
}
const redisGate = credentialGate(['REDIS_URL']);
if (!redisGate.present) {
  console.warn(`[@zapp/control-api] OPS-7 Redis notification test skipped: ${redisGate.reason}`);
}
const closeables: { close?: () => void | Promise<void> }[] = [];

afterEach(async () => {
  for (const closeable of closeables.splice(0)) {
    await Promise.resolve(closeable.close?.());
  }
});

describe.skipIf(!redisGate.present)('OPS-7 Redis notification state', () => {
  it('shares durable preferences and completed delivery claims across replicas', async () => {
    const redis = createRedisConnection(process.env['REDIS_URL'] ?? '');
    closeables.push(redis);
    const first = createRedisNotificationState(redis);
    const second = createRedisNotificationState(redis);
    const organizationId = newId('org');
    const userId = newId('user');
    const preferenceKey = `notification:preference:${organizationId}:${userId}:run_failed`;
    const deliveryKey = `notification:delivery:test:${organizationId}`;

    try {
      await first.setPreference({
        organizationId,
        userId,
        type: 'run_failed',
        email: false,
        inApp: true,
        desktopPush: false,
      });
      await expect(
        second.preference({ organizationId, userId, type: 'run_failed' }),
      ).resolves.toMatchObject({ email: false, inApp: true, desktopPush: false });

      const claim = await first.claimDelivery({
        key: `test:${organizationId}`,
        now: new Date(),
        leaseMs: 60_000,
      });
      expect(claim).toBeTypeOf('string');
      await expect(
        second.claimDelivery({
          key: `test:${organizationId}`,
          now: new Date(),
          leaseMs: 60_000,
        }),
      ).resolves.toBeUndefined();
      await first.completeDelivery(`test:${organizationId}`, claim ?? 'missing');
      await expect(
        second.claimDelivery({
          key: `test:${organizationId}`,
          now: new Date(),
          leaseMs: 60_000,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await redis.delete([preferenceKey, deliveryKey]);
    }
  });
});

async function requireEmptyQueue(queue: NotificationQueuePort): Promise<void> {
  const messages = await queue.receive({
    maxMessages: 10,
    waitTimeSeconds: 0,
    visibilityTimeoutSeconds: 1,
  });
  if (messages.length > 0) {
    throw new Error('OPS-7 integration requires an empty zapp-notifications development queue');
  }
}

describe.skipIf(!gate.present)('OPS-7 LocalStack notification delivery', () => {
  it('delivers the full SQS enqueue to SES path and acknowledges the message', async () => {
    const config = loadNotificationEnv(process.env);
    const queue = createSqsNotificationQueue(config);
    const email = createSesEmailSender(config);
    closeables.push(queue, email);
    await requireEmptyQueue(queue);
    const producer = createNotificationProducer({ queue });
    const worker = createNotificationWorker({
      queue,
      state: createInMemoryNotificationState(),
      directory: {
        resolve: () => Promise.resolve([{ email: 'recipient@example.test' }]),
      },
      email,
      projections: { publish: () => Promise.resolve() },
      webBaseUrl: new URL('https://app.zapp.build'),
    });

    await producer.enqueue({
      triggerId: `localstack:${newId('evt')}`,
      type: 'payment_failed',
      organizationId: newId('org'),
      occurredAt: new Date().toISOString(),
      audience: { kind: 'recipient', email: 'recipient@example.test' },
      context: {},
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    await expect(
      queue.receive({ maxMessages: 1, waitTimeSeconds: 0, visibilityTimeoutSeconds: 1 }),
    ).resolves.toEqual([]);
  }, 15_000);
});
