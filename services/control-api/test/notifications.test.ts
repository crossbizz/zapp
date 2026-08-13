import { newId, type AgentEvent } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInMemoryNotificationState,
  createNotificationProducer,
  createNotificationWorker,
  memberInvitedNotification,
  paymentFailedNotification,
  projectAgentEventNotification,
  syntheticCheckNotification,
  usageAlertNotification,
  type NotificationPreference,
  type NotificationQueuePort,
  type NotificationTrigger,
} from '../src/notifications/service.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

function queue(): NotificationQueuePort & { readonly bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    send(body) {
      bodies.push(body);
      return Promise.resolve();
    },
    receive() {
      const body = bodies[0];
      return Promise.resolve(body === undefined ? [] : [{ body, receiptHandle: 'receipt_1' }]);
    },
    delete() {
      bodies.shift();
      return Promise.resolve();
    },
  };
}

function event(type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    id: newId('evt'),
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    sequence: 1,
    occurredAt: '2026-08-11T20:00:00.000Z',
    type,
    visibility: 'user',
    payload,
  };
}

function trigger(overrides: Partial<NotificationTrigger> = {}): NotificationTrigger {
  return {
    triggerId: 'trigger_approval_1',
    type: 'approval_requested',
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    occurredAt: '2026-08-11T20:00:00.000Z',
    audience: { kind: 'organization', roles: ['owner', 'builder'] },
    context: {},
    ...overrides,
  };
}

describe('OPS-7 notification service', () => {
  it.each([
    ['approval.requested', {}, 'approval_requested'],
    ['run.completed', { status: 'completed' }, 'run_completed'],
    ['run.completed', { status: 'failed' }, 'run_failed'],
    ['deployment.updated', { stage: 'go_live', status: 'passed' }, 'deploy_succeeded'],
    ['deployment.updated', { stage: 'build_artifact', status: 'failed' }, 'deploy_failed'],
  ] as const)('maps %s to the %s notification trigger', (type, payload, expected) => {
    expect(projectAgentEventNotification(event(type, payload))?.type).toBe(expected);
  });

  it('maps budget, synthetic, payment, and invite sources into the trigger catalog', () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const runId = newId('run');
    const occurredAt = '2026-08-11T20:00:00.000Z';

    expect(
      ([50, 80, 100] as const).map(
        (threshold) =>
          usageAlertNotification({
            organizationId,
            runId,
            threshold,
            occurredAt,
          }).type,
      ),
    ).toEqual(['budget_50', 'budget_80', 'budget_100']);
    expect(
      syntheticCheckNotification({
        organizationId,
        projectId,
        syntheticCheckId: newId('syn'),
        operationKey: 'synthetic-operation-1',
        occurredAt,
      }).type,
    ).toBe('synthetic_check_failed');
    expect(
      paymentFailedNotification({ organizationId, invoiceId: 'invoice_1', occurredAt }).type,
    ).toBe('payment_failed');
    expect(
      memberInvitedNotification({
        organizationId,
        email: 'invitee@example.test',
        inviteId: 'invite_1',
        inviteUrl: 'https://app.zapp.build/invites/token',
        occurredAt,
      }).type,
    ).toBe('member_invited');
  });

  it('batches email to at most one message per type, recipient, org, and 15-minute window', async () => {
    const transport = queue();
    const producer = createNotificationProducer({ queue: transport });
    const state = createInMemoryNotificationState();
    const sent: string[] = [];
    const recipient = { userId: newId('user'), email: 'owner@example.test' };
    const worker = createNotificationWorker({
      queue: transport,
      state,
      directory: { resolve: () => Promise.resolve([recipient]) },
      email: {
        send(message) {
          sent.push(message.to);
          return Promise.resolve({ messageId: `email_${String(sent.length)}` });
        },
      },
      projections: { publish: () => Promise.resolve() },
      webBaseUrl: new URL('https://app.zapp.build'),
    });

    const first = trigger({ triggerId: 'trigger_approval_1' });
    await producer.enqueue(first);
    await worker.processOnce();
    await producer.enqueue({ ...first, triggerId: 'trigger_approval_2' });
    await worker.processOnce();

    expect(sent).toEqual(['owner@example.test']);
  });

  it('suppresses disabled channels while retaining enabled in-app delivery', async () => {
    const transport = queue();
    const producer = createNotificationProducer({ queue: transport });
    const state = createInMemoryNotificationState();
    const userId = newId('user');
    const organizationId = newId('org');
    await state.setPreference({
      organizationId,
      userId,
      type: 'approval_requested',
      email: false,
      inApp: true,
      desktopPush: false,
    });
    const emails: string[] = [];
    const projections: string[] = [];
    const input = trigger({ organizationId });
    const worker = createNotificationWorker({
      queue: transport,
      state,
      directory: {
        resolve: () => Promise.resolve([{ userId, email: 'owner@example.test' }]),
      },
      email: {
        send(message) {
          emails.push(message.to);
          return Promise.resolve({ messageId: 'email_1' });
        },
      },
      projections: {
        publish(projection) {
          projections.push(projection.channel);
          return Promise.resolve();
        },
      },
      webBaseUrl: new URL('https://app.zapp.build'),
    });

    await producer.enqueue(input);
    await worker.processOnce();

    expect(emails).toEqual([]);
    expect(projections).toEqual(['in_app']);
  });

  it('fans a retried deployment trigger out to SNS exactly once', async () => {
    const transport = queue();
    const producer = createNotificationProducer({ queue: transport });
    const published: string[] = [];
    const worker = createNotificationWorker({
      queue: transport,
      state: createInMemoryNotificationState(),
      directory: { resolve: () => Promise.resolve([]) },
      email: { send: () => Promise.resolve({ messageId: 'email_1' }) },
      projections: { publish: () => Promise.resolve() },
      fanout: {
        publish(value) {
          published.push(value.triggerId);
          return Promise.resolve();
        },
      },
      webBaseUrl: new URL('https://app.zapp.build'),
    });
    const input = trigger({ triggerId: 'deploy_1', type: 'deploy_succeeded' });

    await producer.enqueue(input);
    await worker.processOnce();
    await producer.enqueue(input);
    await worker.processOnce();

    expect(published).toEqual(['deploy_1']);
  });

  it('exposes tenant-scoped per-user preferences through the versioned API', async () => {
    const state = createInMemoryNotificationState();
    const enqueue = vi.fn<(trigger: NotificationTrigger) => Promise<void>>(() => Promise.resolve());
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      notificationState: state,
      notificationEnqueue: enqueue,
    });
    harnesses.push(built);
    const owner = await signIn(built, {
      externalId: 'notification-owner',
      email: 'notification-owner@zapp.test',
      displayName: 'Notification Owner',
    });
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Notification Organization' },
    });
    expect(organization.statusCode, organization.body).toBe(201);
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };

    const invite = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invites`,
      headers: owner.headers,
      payload: { email: 'invitee@zapp.test', role: 'builder' },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'member_invited',
        organizationId,
        audience: { kind: 'recipient', email: 'invitee@zapp.test' },
      }),
    );

    const updated = await built.app.inject({
      method: 'PUT',
      url: '/v1/notification-preferences/run_failed',
      headers,
      payload: { email: false, inApp: true, desktopPush: false },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const listed = await built.app.inject({
      method: 'GET',
      url: '/v1/notification-preferences',
      headers,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed
        .json<{ preferences: NotificationPreference[] }>()
        .preferences.find((preference) => preference.type === 'run_failed'),
    ).toMatchObject({ email: false, inApp: true, desktopPush: false });

    await state.appendProjection({
      channel: 'desktop_push',
      triggerId: 'trigger_desktop_1',
      type: 'approval_requested',
      organizationId,
      userId: owner.userId,
      occurredAt: '2026-08-12T18:00:00.000Z',
      subject: 'Approval requested',
      text: 'Review the pending approval.',
      webUrl: 'https://app.zapp.build/runs/run_1',
      desktopUrl: 'zapp://runs/run_1',
    });
    await state.appendProjection({
      channel: 'desktop_push',
      triggerId: 'trigger_desktop_1',
      type: 'approval_requested',
      organizationId,
      userId: owner.userId,
      occurredAt: '2026-08-12T18:00:00.000Z',
      subject: 'Approval requested',
      text: 'Review the pending approval.',
      webUrl: 'https://app.zapp.build/runs/run_1',
      desktopUrl: 'zapp://runs/run_1',
    });
    const replayed = await built.app.inject({
      method: 'GET',
      url: '/v1/desktop-notifications?deviceId=device_1&after=0&limit=10',
      headers,
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json()).toMatchObject({
      nextCursor: 1,
      reconnectAfterMs: 1_000,
      notifications: [{ cursor: 1, type: 'approval_requested' }],
    });
    expect(replayed.json<{ notifications: unknown[] }>().notifications).toHaveLength(1);
    expect(replayed.body).not.toContain('token');
  });
});
